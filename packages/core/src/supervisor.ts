// supervisor — start/build/kill a repo's workload via tmux + devspace (spec §7).
// Each `devspace dev` runs inside its own named tmux session so it survives
// daemon restarts and the daemon never blocks on it (spec §5).
import { type RunResult, loginShell, loginShellArgs, run, runStream } from './exec.js'
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

/** Build the shell command that runs `devspace <verb>` the way the user's
 *  `./devspace` wrapper does: cd into the service dir, every `question:` var
 *  pre-answered, and — for multi-service repos — DEVSPACE_BINARY_DIR exported to
 *  the repo root first, so the config's relative Dockerfile/context paths
 *  resolve. Run through `loginShell -lc` so docker/kubectl (off the daemon's
 *  PATH) resolve exactly as they do in a terminal. */
export function devspaceCommand(repo: Repo, verb: string): string {
  const extra = devspaceArgs(repo)
    .map((a) => (a.startsWith('-') ? a : shellQuote(a)))
    .join(' ')
  const cmd = `cd ${shellQuote(repo.path)} && devspace ${verb}${extra ? ` ${extra}` : ''}`
  return repo.root ? `export DEVSPACE_BINARY_DIR=${shellQuote(repo.root)} && ${cmd}` : cmd
}

/** The verb as the user sees it in the logs. Wrapper repos are driven by the
 *  repo's `./devspace` script (it exports DEVSPACE_BINARY_DIR and runs devspace
 *  in the service dir — what devspaceCommand reproduces non-interactively), so
 *  show `./devspace`; plain repos call `devspace` directly. */
export function verbLabel(repo: Repo, verb: string): string {
  const bin = repo.root ? './devspace' : 'devspace'
  return [bin, verb, ...devspaceArgs(repo)].join(' ')
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
    // Run the dev command through a login shell inside the session so it gets
    // the same PATH/env the user has in a terminal (docker/kubectl resolve), and
    // honors the wrapper's DEVSPACE_BINARY_DIR — matching build/kill exactly.
    const inner = `${loginShell} ${loginShellArgs} ${shellQuote(devspaceCommand(repo, 'dev'))}`
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

  /** Build & deploy without entering dev mode: `devspace deploy`, through a
   *  login shell so docker/kubectl resolve (see devspaceCommand). */
  build(repo: Repo, onLine?: LineSink): Promise<RunResult> {
    const args = [loginShellArgs, devspaceCommand(repo, 'deploy')]
    if (!onLine) return this.runner(loginShell, args)
    return this.streamRunner(loginShell, args, {}, onLine)
  }

  /** Tear down: `devspace purge` (through a login shell), then kill the tmux
   *  session if present. */
  async kill(repo: Repo, onLine?: LineSink): Promise<RunResult> {
    const args = [loginShellArgs, devspaceCommand(repo, 'purge')]
    const purge = onLine
      ? await this.streamRunner(loginShell, args, {}, onLine)
      : await this.runner(loginShell, args)
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
