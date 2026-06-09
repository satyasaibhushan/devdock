// supervisor — start/build/kill a repo's workload via tmux + devspace (spec §7).
// Each `devspace dev` runs inside its own named tmux session so it survives
// daemon restarts and the daemon never blocks on it (spec §5).
import { type RunResult, run } from './exec.js'
import type { Repo } from './types.js'

/** Injectable command runner — defaults to the real `run`; swapped in tests. */
export type Runner = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<RunResult>

export class Supervisor {
  constructor(private readonly runner: Runner = run) {}

  /** Start dev mode: `devspace dev` detached inside a named tmux session. */
  start(repo: Repo): Promise<RunResult> {
    const inner = `cd ${shellQuote(repo.path)} && devspace dev`
    return this.runner('tmux', ['new-session', '-d', '-s', repo.session, inner])
  }

  /** Build & deploy without entering dev mode: `devspace deploy`. */
  build(repo: Repo): Promise<RunResult> {
    return this.runner('devspace', ['deploy'], { cwd: repo.path })
  }

  /** Tear down: `devspace purge`, then kill the tmux session if present. */
  async kill(repo: Repo): Promise<RunResult> {
    const purge = await this.runner('devspace', ['purge'], { cwd: repo.path })
    await this.runner('tmux', ['kill-session', '-t', repo.session]).catch(() => undefined)
    return purge
  }

  /** Run a one-off command inside the repo's dev session via `tmux send-keys`. */
  exec(repo: Repo, command: string): Promise<RunResult> {
    return this.runner('tmux', ['send-keys', '-t', repo.session, command, 'Enter'])
  }

  /** Whether a tmux session exists for this repo. */
  async hasSession(repo: Repo): Promise<boolean> {
    const r = await this.runner('tmux', ['has-session', '-t', repo.session])
    return r.code === 0
  }

  /** List live devdock-managed tmux session names. */
  async listSessions(): Promise<string[]> {
    const r = await this.runner('tmux', ['list-sessions', '-F', '#{session_name}'])
    if (r.code !== 0) return []
    return r.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('devdock-'))
  }
}

/** Minimal POSIX single-quote escaping for embedding a path in a shell string. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
