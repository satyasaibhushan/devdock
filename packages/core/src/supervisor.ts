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

export interface SessionState {
  /** true when every pane in the session is a dead remain-on-exit pane. */
  dead: boolean
  /** tmux session creation time as epoch ms, when available. */
  createdAt?: number
}

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
 *  `devdock-dashboard-api-accounts`. The `=` sigil forces an exact match. Use
 *  this for *session*-targeting commands (has-session, kill-session). */
export function exactTarget(session: string): string {
  return `=${session}`
}

/** Pane-targeting commands (pipe-pane, send-keys, capture-pane) reject the bare
 *  `=name` exact-match form with "can't find pane" — the sigil only resolves a
 *  *session* there, not the pane it implies. Appending `:` (the session's active
 *  window/pane) makes the exact match resolve to a pane. Without this every
 *  `tmux pipe-pane` silently no-ops and the dev-pane log stays empty. */
export function exactPane(session: string): string {
  return `=${session}:`
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
    if (r.code !== 0) return r
    // Keep the pane alive after `devspace dev` exits so a died session surfaces
    // as CRASHED (with its last output) instead of the whole session vanishing
    // and the workload silently flipping to RUNNING_EXTERNAL.
    await this.keepalive(repo)
    await this.mouse(repo)
    if (pipeFile) await this.pipe(repo, pipeFile)
    return r
  }

  /** Hold the pane open after its process exits (`remain-on-exit on`). Idempotent;
   *  also applied on reconcile to sessions started before this was set. */
  keepalive(repo: Repo): Promise<RunResult> {
    return this.runner('tmux', [
      'set-option',
      '-w',
      '-t',
      exactPane(repo.session),
      'remain-on-exit',
      'on',
    ])
  }

  /** Turn on tmux mouse mode for the session. Attached terminals are inside
   *  tmux's alternate screen, where a wheel would otherwise degrade into
   *  arrow-key escapes typed at the shell (`^[[A`/`^[[B` garbage); with mouse
   *  mode the wheel reaches tmux, which scrolls the pane's history via
   *  copy-mode. Idempotent; backfilled on reconcile for sessions started
   *  before this was set. Option commands reject the bare `=name` session
   *  target (verified on 3.6b) — like pipe-pane they need the `=name:` form. */
  mouse(repo: Repo): Promise<RunResult> {
    return this.runner('tmux', ['set-option', '-t', exactPane(repo.session), 'mouse', 'on'])
  }

  /** Mirror the session's pane to a file — but only when it isn't already piped.
   *  tmux's `pipe-pane -o` *toggles* rather than being idempotent (verified on
   *  3.6b), so re-asserting it each reconcile would flip the mirror off every
   *  other pass. We check `pane_pipe` ourselves so re-piping recovers a dropped
   *  pipe (tmux server restart) without ever turning a live one off. */
  async pipe(repo: Repo, pipeFile: string): Promise<RunResult> {
    if (await this.isPiped(repo)) return { code: 0, stdout: '', stderr: '' }
    return this.runner('tmux', [
      'pipe-pane',
      '-t',
      exactPane(repo.session),
      `cat >> ${shellQuote(pipeFile)}`,
    ])
  }

  /** Whether the session's pane already has an open output pipe (`pane_pipe`). */
  async isPiped(repo: Repo): Promise<boolean> {
    const r = await this.runner('tmux', [
      'display-message',
      '-p',
      '-t',
      exactPane(repo.session),
      '#{pane_pipe}',
    ])
    return r.code === 0 && r.stdout.trim() === '1'
  }

  /** Build & deploy without entering dev mode: `devspace deploy`, through a
   *  login shell so docker/kubectl resolve (see devspaceCommand). */
  build(repo: Repo, onLine?: LineSink): Promise<RunResult> {
    const args = [loginShellArgs, devspaceCommand(repo, 'deploy')]
    if (!onLine) return this.runner(loginShell, args)
    return this.streamRunner(loginShell, args, {}, onLine)
  }

  /** Tear down: kill the tmux session first — devdock's own `devspace dev`
   *  inside it holds the project's namespace session lock, and a purge run
   *  under a live session fails on that lock — release the lock, then
   *  `devspace purge` through a login shell. */
  async kill(repo: Repo, onLine?: LineSink): Promise<RunResult> {
    await this.runner('tmux', ['kill-session', '-t', exactTarget(repo.session)]).catch(
      () => undefined,
    )
    await this.releaseSessionLock(repo)
    const args = [loginShellArgs, devspaceCommand(repo, 'purge')]
    return onLine
      ? await this.streamRunner(loginShell, args, {}, onLine)
      : await this.runner(loginShell, args)
  }

  /** Clear a crashed dev session without touching the image or deployment.
   *  Kills the local tmux session (alive or dead), releases this project's
   *  namespace session lock, then runs `devspace reset pods` to remove the
   *  replaced dev pod and restore the original deployment. No purge, no rebuild. */
  async clear(repo: Repo, onLine?: LineSink): Promise<RunResult> {
    await this.runner('tmux', ['kill-session', '-t', exactTarget(repo.session)]).catch(
      () => undefined,
    )
    await this.releaseSessionLock(repo)
    const args = [loginShellArgs, devspaceCommand(repo, 'reset pods')]
    return onLine
      ? await this.streamRunner(loginShell, args, {}, onLine)
      : await this.runner(loginShell, args)
  }

  /** Retire a local dev session that no longer has an attributed pod. This is
   *  lighter than `clear`: no reset pods, no purge, no rebuild. It just removes
   *  devdock's stale tmux session and releases this project's DevSpace lock so
   *  reconciliation can fall back to the actual cluster deployment state. */
  async retireSession(repo: Repo): Promise<void> {
    await this.runner('tmux', ['kill-session', '-t', exactTarget(repo.session)]).catch(
      () => undefined,
    )
    await this.releaseSessionLock(repo)
  }

  async stopSession(repo: Repo): Promise<RunResult> {
    const result = await this.runner('tmux', ['kill-session', '-t', exactTarget(repo.session)])
    if (result.code !== 0) return result
    await this.releaseSessionLock(repo)
    return result
  }

  /** Remove this project's entry from the `devspace-dependencies` ConfigMap so
   *  a future `devspace dev` is not blocked by a stale session lock. Best-effort. */
  private async releaseSessionLock(repo: Repo): Promise<void> {
    if (!repo.namespace) return
    const getArgs = [
      'get',
      'configmap',
      'devspace-dependencies',
      '-o',
      'json',
      '-n',
      repo.namespace,
    ]
    const r = await this.runner('kubectl', getArgs).catch(() => undefined)
    if (!r || r.code !== 0) return
    let data: Record<string, string>
    try {
      data = (JSON.parse(r.stdout)?.data ?? {}) as Record<string, string>
    } catch {
      return
    }
    if (!(repo.name in data)) return
    const escaped = repo.name.replace(/~/g, '~0').replace(/\//g, '~1')
    await this.runner('kubectl', [
      'patch',
      'configmap',
      'devspace-dependencies',
      '-n',
      repo.namespace,
      '--type=json',
      '-p',
      JSON.stringify([{ op: 'remove', path: `/data/${escaped}` }]),
    ]).catch(() => undefined)
  }

  /** Run a one-off command inside the repo's dev session via `tmux send-keys`. */
  exec(repo: Repo, command: string): Promise<RunResult> {
    return this.runner('tmux', ['send-keys', '-t', exactPane(repo.session), command, 'Enter'])
  }

  /** PID(s) of the external `devspace dev` session holding this workload's lock —
   *  what Move-Here stops so devdock can take over. DevSpace enforces one session
   *  per project via a `devspace-dependencies` ConfigMap in the namespace: one
   *  key per project (the devspace.yaml `name`, which is `repo.name`) whose value
   *  records the owner as `server: http://localhost:<port>` + a runID. A new
   *  `devspace dev` reads that entry and *pings* the server; if it answers it
   *  refuses ("another session already running"), if not it takes the lock over.
   *
   *  So the owner is exactly whatever process listens on that port. We read the
   *  lock, resolve the port to its listening PID, and return it. A stale lock
   *  (entry present but nothing listening) returns [] — the owner is already gone
   *  and `devspace dev` will take over on its own. When the ConfigMap can't be
   *  read (no namespace, RBAC, kubectl missing) we fall back to scanning for the
   *  `devspace dev` process by its cwd (and WORKLOAD_TYPE for one-config repos). */
  async externalDevPids(repo: Repo): Promise<number[]> {
    const lock = await this.lockOwner(repo)
    if (!lock.readable) return this.externalDevPidsByProcess(repo)
    if (lock.port === undefined) return [] // no lock entry — nothing to take over
    const pid = await this.pidOnPort(lock.port)
    if (pid === undefined) return [] // no listener — stale lock, owner gone
    return (await this.isDevOwner(repo, pid)) ? [pid] : []
  }

  /** Read this project's entry in the namespace's `devspace-dependencies`
   *  ConfigMap (the session lock). `readable:false` means the ConfigMap couldn't
   *  be fetched at all (fall back to a process scan); `readable:true` with no
   *  `port` means there is no live lock for this project. */
  private async lockOwner(repo: Repo): Promise<{ readable: boolean; port?: number }> {
    const args = ['get', 'configmap', 'devspace-dependencies', '-o', 'json']
    if (repo.namespace) args.push('-n', repo.namespace)
    const r = await this.runner('kubectl', args).catch(() => undefined)
    if (!r || r.code !== 0) return { readable: false }
    let data: Record<string, string>
    try {
      data = (JSON.parse(r.stdout)?.data ?? {}) as Record<string, string>
    } catch {
      return { readable: false }
    }
    const payload = data[repo.name]
    if (!payload) return { readable: true }
    // payload is small YAML: `server: http://localhost:8091\nrunID: ...`
    const serverLine = payload.split('\n').find((l) => l.trim().startsWith('server:'))
    const m = serverLine?.match(/:(\d+)\s*$/)
    return { readable: true, port: m ? Number(m[1]) : undefined }
  }

  /** The PID listening on a TCP port (the devspace session's localhost server),
   *  or undefined when nothing listens there. */
  private async pidOnPort(port: number): Promise<number | undefined> {
    const r = await this.runner('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']).catch(
      () => undefined,
    )
    if (!r || r.code !== 0) return undefined
    const p = r.stdout.split('\n').find((l) => l.startsWith('p'))
    return p ? Number(p.slice(1)) : undefined
  }

  /** Fallback owner lookup when the lock ConfigMap is unreadable: match a
   *  `devspace dev` process by its service-dir cwd (devspaceCommand cd's there,
   *  as the user's wrapper does), and — for a one-config multi-workload repo —
   *  the `WORKLOAD_TYPE` var, so we never touch a sibling workload. */
  private async externalDevPidsByProcess(repo: Repo): Promise<number[]> {
    const ps = await this.runner('ps', ['-axww', '-o', 'pid=,command=']).catch(() => undefined)
    if (!ps || ps.code !== 0) return []
    const out: number[] = []
    for (const line of ps.stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/)
      if (!m) continue
      const cmd = m[2] as string
      if (this.commandMatches(repo, cmd) && (await this.cwdOf(Number(m[1]))) === repo.path) {
        out.push(Number(m[1]))
      }
    }
    return out
  }

  /** The working directory of a process (macOS/Linux via lsof), or undefined. */
  private async cwdOf(pid: number): Promise<string | undefined> {
    const r = await this.runner('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).catch(
      () => undefined,
    )
    if (!r || r.code !== 0) return undefined
    // -Fn field output: a line per field, the cwd path on an `n`-prefixed line.
    const n = r.stdout.split('\n').find((l) => l.startsWith('n'))
    return n ? n.slice(1) : undefined
  }

  private commandMatches(repo: Repo, command: string): boolean {
    if (!/devspace\s+dev\b/.test(command)) return false
    const workload = repo.varDefaults?.WORKLOAD_TYPE
    return !workload || command.includes(`WORKLOAD_TYPE=${workload}`)
  }

  /** A port number or PID is only a hint. Prove both executable role and cwd
   *  before returning or signalling it, so stale locks and PID reuse fail shut. */
  private async isDevOwner(repo: Repo, pid: number): Promise<boolean> {
    const ps = await this.runner('ps', ['-o', 'command=', '-p', String(pid)]).catch(() => undefined)
    return (
      !!ps &&
      ps.code === 0 &&
      this.commandMatches(repo, ps.stdout) &&
      (await this.cwdOf(pid)) === repo.path
    )
  }

  /** Whether a process is still alive (`kill -0`). */
  private async alive(pid: number): Promise<boolean> {
    const r = await this.runner('kill', ['-0', String(pid)]).catch(() => undefined)
    return !!r && r.code === 0
  }

  /** Stop the external `devspace dev` session holding this workload's lock so
   *  devdock can take over. SIGTERM first — devspace then releases its namespace
   *  session lock and tears down its port-forward/sync cleanly while LEAVING the
   *  replaced dev pod running — then SIGKILL anything that lingers. It signals
   *  only the lock's owning process (resolved from the ConfigMap's server port,
   *  see externalDevPids); it never runs `devspace purge`/`deploy`, so the
   *  deployment, image, and any other workloads in the namespace are untouched.
   *  Returns the pids it signalled (empty when the lock is already free/stale —
   *  `devspace dev` then reconnects to the existing dev pod by itself). */
  async stopExternalDev(
    repo: Repo,
    onLine?: LineSink,
    grace: { tries?: number; intervalMs?: number } = {},
  ): Promise<{ pids: number[] }> {
    const tries = grace.tries ?? 20
    const intervalMs = grace.intervalMs ?? 300
    const pids = await this.externalDevPids(repo)
    const signalled: number[] = []
    for (const pid of pids) {
      // Re-read the lock and process identity immediately before the signal.
      // A PID resolved moments ago may already belong to another process.
      if (!(await this.externalDevPids(repo)).includes(pid)) continue
      onLine?.(`stopping external devspace dev (pid ${pid})`)
      await this.runner('kill', ['-TERM', String(pid)]).catch(() => undefined)
      signalled.push(pid)
    }
    // Give devspace time (default ~6s) to release its session and exit cleanly.
    for (let i = 0; i < tries; i++) {
      if (!(await this.anyAlive(signalled))) break
      await delay(intervalMs)
    }
    for (const pid of signalled) {
      if ((await this.alive(pid)) && (await this.isDevOwner(repo, pid))) {
        onLine?.(`force-killing devspace dev (pid ${pid})`)
        await this.runner('kill', ['-KILL', String(pid)]).catch(() => undefined)
      }
    }
    return { pids: signalled }
  }

  private async anyAlive(pids: number[]): Promise<boolean> {
    for (const pid of pids) {
      if (await this.alive(pid)) return true
    }
    return false
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

  /** devdock sessions mapped to whether their dev process has exited — i.e. all
   *  panes are dead (held open by `remain-on-exit`). One `list-panes -a` answers
   *  the whole reconcile pass, so it's a single tmux call regardless of repo
   *  count. A session present here with `false` is a healthy managed dev session;
   *  `true` means `devspace dev` exited and the session is a crashed shell. */
  async sessionStates(): Promise<Map<string, SessionState>> {
    const r = await this.runner('tmux', [
      'list-panes',
      '-a',
      '-F',
      '#{session_name} #{pane_dead} #{session_created}',
    ])
    const out = new Map<string, SessionState>()
    if (r.code !== 0) return out
    for (const line of r.stdout.split('\n')) {
      const [name, dead, created] = line.trim().split(' ')
      if (!name?.startsWith('devdock-')) continue
      const previous = out.get(name)
      const createdAt = created && /^\d+$/.test(created) ? Number(created) * 1000 : undefined
      // A session is dead only if every one of its panes is dead.
      out.set(name, {
        dead: (previous?.dead ?? true) && dead === '1',
        createdAt: previous?.createdAt ?? createdAt,
      })
    }
    return out
  }
}

/** Minimal POSIX single-quote escaping for embedding a path in a shell string. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
