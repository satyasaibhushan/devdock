// ptyBroker — node-pty ↔ `tmux attach`, with a single write-lock per repo (spec §8).
// Read-only is the default; read-write is a held lock (spec design rule §5).
import type { Repo, TermMode } from './types.js'

/** Minimal subset of node-pty's IPty the broker depends on (keeps tests pty-free). */
export interface PtyLike {
  onData(cb: (data: string) => void): void
  onExit(cb: () => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export type PtySpawn = (
  file: string,
  args: string[],
  opts: { cols: number; rows: number },
) => PtyLike

/** Lazy real node-pty spawner (imported only when no spawner is injected). */
async function defaultSpawn(): Promise<PtySpawn> {
  const pty = await import('node-pty')
  return (file, args, opts) =>
    pty.spawn(file, args, { cols: opts.cols, rows: opts.rows, name: 'xterm-color' })
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

  /** Open a terminal. Read-write requires (and holds) the repo's write-lock. */
  async open(repo: Repo, mode: TermMode, cols = 80, rows = 24): Promise<TermSession> {
    let token: symbol | null = null
    if (mode === 'rw') {
      token = this.locks.acquire(repo.id)
      if (!token) throw new Error(`write-lock held for ${repo.id}`)
    }

    const spawn = await this.resolveSpawn()
    const pty = spawn('tmux', attachArgs(repo.session, mode), { cols, rows })

    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      pty.kill()
      if (token) this.locks.release(repo.id, token)
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
