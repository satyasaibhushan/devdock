// ptyBroker — node-pty ↔ `tmux attach`, with a single write-lock per repo (spec §8).
// Read-only is the default; read-write is a held lock (spec design rule §5).
import { chmodSync, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { arch, platform } from 'node:process'
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
  ensureNodePtySpawnHelperExecutable()
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

/** node-pty launches child processes through a small native `spawn-helper`.
 *  Some pnpm/prebuild extraction paths can leave that helper without executable
 *  bits, which makes every terminal fail with the opaque "posix_spawnp failed".
 *  Repair it once before the first PTY spawn. */
export function ensureNodePtySpawnHelperExecutable(): void {
  const require = createRequire(import.meta.url)
  let pkgRoot: string
  try {
    pkgRoot = dirname(require.resolve('node-pty/package.json'))
  } catch {
    return
  }
  for (const helper of [
    join(pkgRoot, 'prebuilds', `${platform}-${arch}`, 'spawn-helper'),
    join(pkgRoot, 'build', 'Release', 'spawn-helper'),
  ]) {
    if (!existsSync(helper)) continue
    ensureExecutable(helper)
    return
  }
}

export function ensureExecutable(path: string): void {
  const mode = statSync(path).mode
  if ((mode & 0o111) === 0o111) return
  chmodSync(path, mode | 0o755)
}

/** The tmux command a terminal of `mode` attaches with (spec §8).
 *  `=` forces an exact session-name match — tmux `-t` matching is otherwise
 *  prefix-based and could attach a sibling repo's session.
 *  Read-only deliberately does NOT use tmux's `-r` flag: a `-r` client ignores
 *  ALL input, including the mouse-wheel reports that scroll pane history. The
 *  broker enforces read-only itself by letting only wheel reports through
 *  (see isWheelReport) — scrolling works, typing doesn't. */
export function attachArgs(session: string, _mode: TermMode): string[] {
  return ['attach', '-t', `=${session}`]
}

/** One or more SGR mouse *wheel* reports (button 64 = up, 65 = down) and
 *  nothing else. This is the only input a read-only terminal may deliver to
 *  its PTY: enough for tmux (or a full-screen app) to scroll, never enough to
 *  type — any keystroke or click fails the match and is dropped. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC of SGR mouse reports is the point
const WHEEL_REPORT_RE = /^(?:\x1b\[<6[45];\d+;\d+[Mm])+$/
export function isWheelReport(data: string): boolean {
  return WHEEL_REPORT_RE.test(data)
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
  /** Forward input to the PTY. Read-only sessions let wheel reports through
   *  (scrolling) and drop everything else. */
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

  /**
   * Attach the repo's tmux dev session. This is one shared screen, so a
   * read-write attach takes (and holds) the repo's single-writer lock — two
   * writers on the same session would fight over the keyboard.
   */
  open(repo: Repo, mode: TermMode, cols = 80, rows = 24): Promise<TermSession> {
    return this.attach(repo, mode, 'tmux', attachArgs(repo.session, mode), undefined, cols, rows, {
      lock: true,
    })
  }

  /**
   * Shell into the repo's running container via `devspace enter` — the fallback
   * for externally-started deployments that have pods but no devdock tmux
   * session, and the target for every extra "+" terminal. Runs in the repo
   * directory so devspace resolves namespace and container from the project's
   * own devspace.yaml (which imports/vars make unparseable statically).
   *
   * We pin `--pod <name>` to the pod the reconciler already attributed to this
   * workload. This is essential because all workloads share one namespace: an
   * unscoped `devspace enter --pick=false` auto-picks the first matching pod in
   * the namespace — i.e. a *different* service's pod — so without `--pod` a shell
   * for `career-service-agents` lands in `dashboard-api-accounts`. `--wait` then
   * covers a pod that's still `ContainerCreating`. The name can in theory go
   * stale (the pod rolled since the last reconcile), but that surfaces as a
   * retryable "pod not found" — far better than silently entering the wrong
   * service. Without a pod name we fall back to the selector-based auto-pick.
   *
   * No write-lock: each `devspace enter` is an independent exec into the pod (its
   * own TTY, like a fresh SSH session), so any number can run read-write at once
   * without conflict — that's what lets the UI open multiple terminals into one
   * pod (VS Code style). The lock only guards the single shared tmux session.
   */
  openShell(repo: Repo, mode: TermMode, cols = 80, rows = 24, pod?: string): Promise<TermSession> {
    const args = pod ? ['enter', '--pod', pod, '--wait'] : ['enter', '--pick=false', '--wait']
    // Pin the namespace when the repo has one (config-declared or session-
    // pinned) — otherwise `devspace enter` searches the kube context's current
    // namespace, which may have moved since this workload started.
    if (repo.namespace) args.push('-n', repo.namespace)
    return this.attach(repo, mode, 'devspace', args, repo.path, cols, rows, { lock: false })
  }

  private async attach(
    repo: Repo,
    mode: TermMode,
    file: string,
    args: string[],
    cwd: string | undefined,
    cols: number,
    rows: number,
    opts: { lock: boolean },
  ): Promise<TermSession> {
    let token: symbol | null = null
    if (mode === 'rw' && opts.lock) {
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
        // rw: everything. ro: wheel reports only — scroll, never type.
        if (mode === 'rw' || isWheelReport(data)) pty.write(data)
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
