// supervisor — start/build/kill a repo's workload via tmux + devspace (spec §7).
// Each `devspace dev` runs inside its own named tmux session so it survives
// daemon restarts and the daemon never blocks on it (spec §5).
import { type RunResult, run, runStream } from './exec.js'
import type { Repo } from './types.js'

/** Injectable command runner — defaults to the real `run`; swapped in tests. */
export type Runner = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<RunResult>

/** Runner that also emits output lines as they arrive (defaults to `runStream`). */
export type StreamRunner = (
  cmd: string,
  args: string[],
  opts: { cwd?: string },
  onLine: (line: string) => void,
) => Promise<RunResult>

export type LineSink = (line: string) => void

/** Args that make devspace run without user input: every `question:` var is
 *  answered with its declared default (what the user's ddev/dpurge/ddep
 *  aliases do by hand), and the namespace is pinned when the config names one
 *  so the verb doesn't depend on the current kubectl context. */
export function devspaceArgs(repo: Repo): string[] {
  const args: string[] = []
  for (const [key, value] of Object.entries(repo.varDefaults ?? {})) {
    args.push('--var', `${key}=${value}`)
  }
  if (repo.namespace) args.push('-n', repo.namespace)
  return args
}

/** tmux `-t` matches session names by prefix, so `devdock-dashboard` would hit
 *  `devdock-dashboard-api-accounts`. The `=` sigil forces an exact match. */
export function exactTarget(session: string): string {
  return `=${session}`
}

export class Supervisor {
  private readonly runner: Runner
  private readonly streamRunner: StreamRunner

  constructor(runner?: Runner, streamRunner?: StreamRunner) {
    this.runner = runner ?? run
    // An injected plain runner (tests) doubles as the stream runner — output
    // then arrives only in the RunResult, which is fine for canned fakes.
    this.streamRunner = streamRunner ?? (runner ? (c, a, o) => runner(c, a, o) : runStream)
  }

  /** Start dev mode: `devspace dev` detached inside a named tmux session.
   *  With `pipeFile`, the pane is mirrored there via `tmux pipe-pane` so the
   *  daemon can tail the same output you'd see running `devspace dev` yourself. */
  async start(repo: Repo, pipeFile?: string): Promise<RunResult> {
    const extra = devspaceArgs(repo)
      .map((a) => (a.startsWith('-') ? a : shellQuote(a)))
      .join(' ')
    const inner = `cd ${shellQuote(repo.path)} && devspace dev${extra ? ` ${extra}` : ''}`
    const r = await this.runner('tmux', ['new-session', '-d', '-s', repo.session, inner])
    if (r.code === 0 && pipeFile) await this.pipe(repo, pipeFile)
    return r
  }

  /** Mirror the session's pane to a file. `-o` makes it a no-op if already piped. */
  pipe(repo: Repo, pipeFile: string): Promise<RunResult> {
    return this.runner('tmux', [
      'pipe-pane',
      '-o',
      '-t',
      exactTarget(repo.session),
      `cat >> ${shellQuote(pipeFile)}`,
    ])
  }

  /** Build & deploy without entering dev mode: `devspace deploy`. */
  build(repo: Repo, onLine?: LineSink): Promise<RunResult> {
    const args = ['deploy', ...devspaceArgs(repo)]
    if (!onLine) return this.runner('devspace', args, { cwd: repo.path })
    return this.streamRunner('devspace', args, { cwd: repo.path }, onLine)
  }

  /** Tear down: `devspace purge`, then kill the tmux session if present. */
  async kill(repo: Repo, onLine?: LineSink): Promise<RunResult> {
    const args = ['purge', ...devspaceArgs(repo)]
    const purge = onLine
      ? await this.streamRunner('devspace', args, { cwd: repo.path }, onLine)
      : await this.runner('devspace', args, { cwd: repo.path })
    await this.runner('tmux', ['kill-session', '-t', exactTarget(repo.session)]).catch(
      () => undefined,
    )
    return purge
  }

  /** Run a one-off command inside the repo's dev session via `tmux send-keys`. */
  exec(repo: Repo, command: string): Promise<RunResult> {
    return this.runner('tmux', ['send-keys', '-t', exactTarget(repo.session), command, 'Enter'])
  }

  /** Whether a tmux session exists for this repo. */
  async hasSession(repo: Repo): Promise<boolean> {
    const r = await this.runner('tmux', ['has-session', '-t', exactTarget(repo.session)])
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
