// ptyBroker — node-pty ↔ `tmux attach`, with a single write-lock per repo (spec §8).
// Read-only is the default; read-write is a held lock (spec design rule §5).
import type { Repo, TermMode } from './types.js'

/**
 * Grace period before a closed pty is reaped. node-pty leaks the master
 * /dev/ptmx fd if killed in the same event-loop turn it was spawned, so teardown
 * is deferred at least this long. Empirically ~10ms suffices; 50ms is a safe
 * margin and imperceptible for a closing terminal.
 */
const PTY_TEARDOWN_GRACE_MS = 50

/** Minimal subset of node-pty's IPty the broker depends on (keeps tests pty-free). */
export interface PtyLike {
  onData(cb: (data: string) => void): void
  onExit(cb: () => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  /**
   * Full teardown: destroys the master read stream and releases the /dev/ptmx
   * slot. node-pty's kill() only signals the child — it leaves the master fd
   * open until the (possibly never-flowing) read stream emits 'close', so a
   * terminal closed before any onData consumer attached would leak a PTY.
   * Optional: injected test fakes fall back to kill().
   */
  destroy?(): void
}

export type PtySpawn = (
  file: string,
  args: string[],
  opts: { cols: number; rows: number; cwd?: string },
) => PtyLike

/** Lazy real node-pty spawner (imported only when no spawner is injected). */
async function defaultSpawn(): Promise<PtySpawn> {
  const pty = await import('node-pty')
  return (file, args, opts) => {
    const p = pty.spawn(file, args, {
      cols: opts.cols,
      rows: opts.rows,
      name: 'xterm-color',
      cwd: opts.cwd,
    })
    return {
      onData: (cb) => p.onData(cb),
      onExit: (cb) => p.onExit(() => cb()),
      write: (data) => p.write(data),
      resize: (cols, rows) => p.resize(cols, rows),
      kill: () => p.kill(),
      // node-pty's UnixTerminal exposes destroy(); WindowsTerminal does not.
      destroy: () => {
        const d = (p as unknown as { destroy?: () => void }).destroy
        if (typeof d === 'function') d.call(p)
        else p.kill()
      },
    }
  }
}

/** The tmux command a terminal of `mode` attaches with (spec §8). */
export function attachArgs(session: string, mode: TermMode): string[] {
  return mode === 'ro' ? ['attach', '-r', '-t', session] : ['attach', '-t', session]
}

/** Single-writer lock: one read-write terminal per repo at a time (spec §5). */
export class WriteLock {
  private held = new Map<string, symbol>()

  acquire(repo: string): symbol | null {
    if (this.held.has(repo)) return null
    const token = Symbol(repo)
    this.held.set(repo, token)
    return token
  }

  release(repo: string, token: symbol): boolean {
    if (this.held.get(repo) !== token) return false
    this.held.delete(repo)
    return true
  }

  isHeld(repo: string): boolean {
    return this.held.has(repo)
  }
}

/** A live terminal session bound to a tmux attach via node-pty. */
export interface TermSession {
  readonly mode: TermMode
  onData(cb: (data: string) => void): void
  /** Forward input to the pod. No-op for read-only sessions. */
  write(data: string): void
  resize(cols: number, rows: number): void
  close(): void
}

export class PtyBroker {
  readonly locks = new WriteLock()
  /** Injected for tests; lazily resolved from node-pty otherwise. */
  private spawn?: PtySpawn
  constructor(spawn?: PtySpawn) {
    this.spawn = spawn
  }

  /** Attach the repo's tmux dev session. Read-write requires (and holds) the repo's write-lock. */
  open(repo: Repo, mode: TermMode, cols = 80, rows = 24): Promise<TermSession> {
    return this.attach(repo, mode, 'tmux', attachArgs(repo.session, mode), undefined, cols, rows)
  }

  /**
   * Shell into the repo's running container via `devspace enter` — the fallback
   * for externally-started deployments that have pods but no devdock tmux
   * session. Runs in the repo directory so devspace resolves namespace/selector
   * from the project's own devspace.yaml (which imports/vars make unparseable
   * statically). Passing the pod skips devspace's interactive picker.
   */
  openShell(repo: Repo, mode: TermMode, cols = 80, rows = 24, pod?: string): Promise<TermSession> {
    const args = pod ? ['enter', '--pod', pod] : ['enter']
    return this.attach(repo, mode, 'devspace', args, repo.path, cols, rows)
  }

  private async attach(
    repo: Repo,
    mode: TermMode,
    file: string,
    args: string[],
    cwd: string | undefined,
    cols: number,
    rows: number,
  ): Promise<TermSession> {
    let token: symbol | null = null
    if (mode === 'rw') {
      token = this.locks.acquire(repo.id)
      if (!token) throw new Error(`write-lock held for ${repo.id}`)
    }

    const spawn = await this.resolveSpawn()
    const pty = spawn(file, args, { cols, rows, cwd })

    let closed = false
    const teardown = () => {
      // Two-step teardown. kill() SIGHUPs the child (the `tmux attach` client) so
      // it detaches and exits — node-pty's destroy() alone defers that SIGHUP to a
      // socket 'close' event that never fires when the read stream was never
      // consumed, stranding the attach client. destroy() then releases the master
      // /dev/ptmx fd regardless of stream flow state.
      try {
        pty.kill()
      } catch {
        /* pid already gone */
      }
      try {
        pty.destroy?.()
      } catch {
        /* socket already torn down */
      }
    }
    const close = () => {
      if (closed) return
      closed = true
      // Release the write-lock immediately so a new rw terminal isn't blocked.
      if (token) this.locks.release(repo.id, token)
      // Defer the fd teardown past the spawn tick. node-pty cannot release the
      // master /dev/ptmx fd if the pty is killed in the same event-loop turn it
      // was spawned (libuv's PTY wiring hasn't settled) — it leaks the slot. The
      // socket-closed-before-open()-resolved race tears down in exactly that
      // window, so give every pty a brief grace period before reaping it. unref()
      // keeps this timer from holding the process (or test runner) open.
      const timer: ReturnType<typeof setTimeout> = setTimeout(teardown, PTY_TEARDOWN_GRACE_MS)
      timer.unref?.()
    }
    pty.onExit(close)

    return {
      mode,
      onData: (cb) => pty.onData(cb),
      write: (data) => {
        if (mode === 'rw') pty.write(data)
      },
      resize: (c, r) => pty.resize(c, r),
      close,
    }
  }

  private async resolveSpawn(): Promise<PtySpawn> {
    if (!this.spawn) this.spawn = await defaultSpawn()
    return this.spawn
  }
}
