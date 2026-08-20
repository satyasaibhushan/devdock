// auth — the daemon-side owner of Kubernetes OIDC login (int128 kubelogin).
//
// Why this exists: the kubeconfig authenticates via an exec plugin
// (`kubectl oidc-login get-token --listen-address=localhost:8040`). Every
// kubectl/devspace process that runs while the cached token is invalid spawns
// its own kubelogin, and each one races to bind the fixed localhost port and
// opens its own browser tab — only the first wins, the rest fail, and the
// login page keeps popping up. The fix is to make the daemon the ONE place
// interactive login ever happens:
//
//  - token freshness is read straight from kubelogin's cache (a JWT decode,
//    no process spawn), so the reconcile loop can gate kubectl cheaply;
//  - silent refresh runs `get-token --skip-open-browser` under a timeout, so
//    it can never open a browser or hang the daemon (refresh works from any
//    network — only the interactive Google page is IP-restricted to the
//    office);
//  - explicit login is single-flight and uses `--skip-open-browser`; its URL is
//    surfaced to the UI/MCP for a deliberate user click;
//  - kubectl calls are refused while login is required (see kubectlAllowed),
//    so the 5s reconcile loop can't trigger login storms.
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type RunOptions, type RunResult, run, runStream } from './exec.js'

/** Runner with timeout support — auth probes MUST be killable (a kubelogin
 *  waiting for a browser callback would otherwise hang the daemon forever). */
export type AuthRunner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>
export type AuthLoginRunner = (
  cmd: string,
  args: string[],
  opts: RunOptions,
  onLine: (line: string) => void,
) => Promise<RunResult>

export type AuthPhase = 'unknown' | 'ok' | 'login_required' | 'logging_in' | 'error'

export interface AuthState {
  /** Whether the kubeconfig authenticates via kubelogin at all. When false the
   *  manager is a permanent no-op (plain clusters, tests). */
  oidc: boolean
  phase: AuthPhase
  /** Human hint for the UI (why login is needed / what to do). */
  message?: string
  /** Cached id_token expiry (epoch ms), when present and parseable. */
  tokenExpiresAt?: number
  loginUrl?: string
  checkedAt: number
}

export interface AuthManagerOptions {
  runner?: AuthRunner
  loginRunner?: AuthLoginRunner
  /** kubelogin's token cache — the dir behind `rm -r ~/.kube/cache/oidc-login`. */
  cacheDir?: string
  probeTimeoutMs?: number
  loginTimeoutMs?: number
  /** How long a cache-dir read is trusted before re-reading (tests set 0). */
  expiryTtlMs?: number
}

/** Consider a token stale this long before its real expiry, so a verb never
 *  starts with a token that dies mid-`devspace deploy`. */
const TOKEN_MARGIN_MS = 60_000
/** Background maintenance renews the token when it has less than this left —
 *  kubelogin only refreshes an *expired* token on its own, so `--force-refresh`
 *  here keeps the cache perpetually fresh and login interruptions rare. */
const REFRESH_AHEAD_MS = 20 * 60_000
/** A probe that needs the browser prints a URL and waits for the callback —
 *  kill it well before kubelogin's own 180s authcode timeout. */
const PROBE_TIMEOUT_MS = 20_000
/** Interactive login: kubelogin's authcode flow times out at 180s; give it
 *  slack, then kill so a verb can't hang forever. */
const LOGIN_TIMEOUT_MS = 190_000
/** How long a cache-dir read is trusted before re-reading (gate() runs per
 *  kubectl call, several times per reconcile pass). */
const EXPIRY_TTL_MS = 2_000
/** How long the parsed kubeconfig exec args are trusted. */
const EXEC_ARGS_TTL_MS = 5 * 60_000

export const OFF_NETWORK_HINT =
  'if you are off the office network, the Google sign-in page is IP-restricted — connect to the office network/VPN and retry'

/** Output that means kubelogin gave up on the cache and started the
 *  interactive authcode flow (it prints the URL and waits for the callback). */
const INTERACTIVE_RE = /visit the following URL|open the browser|authentication in progress/i

/** kubelogin could not bind its fixed callback port — another kubelogin
 *  (a devspace dev session refreshing its own token, a kubectl in a terminal)
 *  is already waiting on it. It exits immediately, without opening a browser. */
const BIND_ERROR_RE = /address already in use/i

export class AuthManager {
  private readonly runner: AuthRunner
  private readonly loginRunner: AuthLoginRunner
  private readonly cacheDir: string
  private readonly probeTimeoutMs: number
  private readonly loginTimeoutMs: number
  private readonly expiryTtlMs: number

  /** undefined = kubeconfig not inspected yet (gate stays open — pre-init
   *  behaviour is exactly the old, ungated devdock). */
  private oidc: boolean | undefined
  private phase: AuthPhase = 'unknown'
  private message: string | undefined
  private checkedAt = 0
  private loginUrl: string | undefined
  private identity: { issuer: string; clientId: string } | undefined

  private execArgsCache: { args: string[] | null; at: number } | undefined
  private expiryCache: { expiresAt: number | undefined; at: number } | undefined

  /** Serializes probe/refresh/login — kubelogin binds a fixed localhost port,
   *  so two live instances always fight. */
  private lock: Promise<unknown> = Promise.resolve()
  private probing: Promise<AuthState> | null = null
  private logging: Promise<AuthState> | null = null

  constructor(opts: AuthManagerOptions = {}) {
    this.runner = opts.runner ?? run
    this.loginRunner =
      opts.loginRunner ??
      (opts.runner
        ? async (cmd, args, runOpts, onLine) => {
            const result = await this.runner(cmd, args, runOpts)
            for (const line of `${result.stdout}\n${result.stderr}`.split('\n')) {
              if (line) onLine(line)
            }
            return result
          }
        : runStream)
    this.cacheDir = opts.cacheDir ?? join(homedir(), '.kube', 'cache', 'oidc-login')
    this.probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS
    this.loginTimeoutMs = opts.loginTimeoutMs ?? LOGIN_TIMEOUT_MS
    this.expiryTtlMs = opts.expiryTtlMs ?? EXPIRY_TTL_MS
  }

  snapshot(): AuthState {
    return {
      oidc: this.oidc === true,
      phase: this.oidc === false ? 'ok' : this.phase,
      message: this.message,
      tokenExpiresAt: this.tokenExpiresAt(),
      loginUrl: this.loginUrl,
      checkedAt: this.checkedAt,
    }
  }

  /** Inspect the kubeconfig once at boot and settle the initial phase. */
  async init(): Promise<AuthState> {
    const args = await this.execArgs()
    if (!args) return this.noExecArgsState()
    return this.probe()
  }

  /** Re-read the active kube context before a reconcile pass. A context change
   *  invalidates the previous identity immediately, even when its token has a
   *  later expiry. */
  async syncContext(): Promise<AuthState> {
    if (this.logging || this.probing) return this.snapshot()
    if (this.phase === 'login_required' || this.phase === 'error') return this.snapshot()
    const args = await this.execArgs(true)
    if (!args) return this.noExecArgsState()
    if (this.tokenFresh(TOKEN_MARGIN_MS)) return this.settle('ok', undefined)
    return this.probe()
  }

  /** Whether this kubectl invocation may run right now. `config`/`oidc-login`
   *  subcommands are local (no API server, no token) and always pass. API
   *  calls pass only on a fresh cached token — otherwise a silent refresh is
   *  kicked off (single-flight) and the call is refused, so a stale token can
   *  never fan out into per-process kubelogin browser storms.
   *
   *  Once the phase is login_required/error, no more probes are kicked from here: a
   *  dead refresh token cannot be fixed silently, and re-probing every tick
   *  would hold kubelogin's callback port ~85% of the time — starving the
   *  Login button (and any external kubelogin) of the port. */
  kubectlAllowed(args: string[]): boolean {
    const sub = args[0]
    if (sub === 'config' || sub === 'oidc-login') return true
    if (this.oidc !== true) return true
    if (this.tokenFresh(TOKEN_MARGIN_MS)) return true
    if (this.phase === 'unknown' || this.phase === 'ok') void this.probe().catch(() => undefined)
    return false
  }

  /** Silent freshness check. It never starts an interactive login and never
   *  retries a settled failure; only login() may do that. */
  async ensure(): Promise<AuthState> {
    if (this.oidc === undefined) await this.execArgs()
    if (this.phase === 'error') return this.snapshot()
    if (this.oidc !== true) return this.settle('ok', undefined)
    if (this.tokenFresh(TOKEN_MARGIN_MS)) return this.settle('ok', undefined)
    if (this.phase === 'login_required') return this.snapshot()
    return this.probe()
  }

  /** Silent check-and-refresh: never opens a browser. Joins an in-flight
   *  probe/login instead of stacking another kubelogin on the port. */
  probe(): Promise<AuthState> {
    if (this.logging) return this.logging
    if (this.probing) return this.probing
    const p = this.exclusive(() => this.doProbe(false, TOKEN_MARGIN_MS)).finally(() => {
      this.probing = null
    })
    this.probing = p
    return p
  }

  /** Background maintenance: renew the token before it expires (kubelogin only
   *  refreshes an already-expired one on its own — `--force-refresh` keeps the
   *  cache warm so kubectl/devspace never see a stale token). Silent. */
  maintain(): Promise<AuthState> {
    if (this.phase === 'login_required' || this.phase === 'error') {
      return Promise.resolve(this.snapshot())
    }
    if (this.logging) return this.logging
    if (this.probing) return this.probing
    const p = this.exclusive(() => this.doProbe(true, REFRESH_AHEAD_MS)).finally(() => {
      this.probing = null
    })
    this.probing = p
    return p
  }

  /** Explicit, single-flight login. kubelogin prints a URL but is forbidden
   *  from opening it; only a user click or this method may start an attempt. */
  login(): Promise<AuthState> {
    if (this.logging) return this.logging
    // Set this before queueing behind a probe. The HTTP handler returns a
    // snapshot immediately, and the UI must show that the click was accepted
    // even when another auth check owns the kubelogin lock for a moment.
    this.loginUrl = undefined
    this.settle('logging_in', 'preparing Kubernetes sign-in')
    const p = this.exclusive(() => this.doLogin()).finally(() => {
      this.logging = null
    })
    this.logging = p
    return p
  }

  /** `rm -r ~/.kube/cache/oidc-login` as a button. */
  clearCache(): AuthState {
    // A login/probe owns kubelogin's fixed callback port. Do not hide that
    // operation by replacing its visible state with `login_required`: a later
    // Login click would only join the hidden operation and appear inert.
    if (this.logging || this.probing) return this.snapshot()
    rmSync(this.cacheDir, { recursive: true, force: true })
    this.expiryCache = undefined
    this.loginUrl = undefined
    if (this.oidc === true) {
      return this.settle('login_required', 'auth cache cleared — log in again')
    }
    return this.snapshot()
  }

  // ---- internals ----

  private async doProbe(forceRefresh: boolean, marginMs: number): Promise<AuthState> {
    const args = await this.execArgs()
    if (!args) return this.noExecArgsState()
    this.expiryCache = undefined
    if (this.tokenFresh(marginMs)) return this.settle('ok', undefined)

    const extra = forceRefresh
      ? ['--force-refresh', '--skip-open-browser']
      : ['--skip-open-browser']
    const r = await this.runner(args[0] as string, [...args.slice(1), ...extra], {
      timeoutMs: this.probeTimeoutMs,
    })
    this.expiryCache = undefined
    if (r.code === 0) return this.settle('ok', undefined)

    const out = `${r.stdout}\n${r.stderr}`
    if (r.code < 0 || INTERACTIVE_RE.test(out)) {
      // It fell back to the interactive flow (we killed it before it could
      // wait 3 minutes for a browser callback that was never coming).
      return this.settle('login_required', `Kubernetes login required — ${OFF_NETWORK_HINT}`)
    }
    if (BIND_ERROR_RE.test(out)) {
      // Another kubelogin is mid-interactive-flow on the callback port — that
      // only happens when its refresh failed too, so login IS required. Leave
      // the squatter alone: its sign-in tab may be open in front of the user.
      return this.settle(
        'login_required',
        'Kubernetes login required — another sign-in is already waiting (check for an open tab, or click log in to take over)',
      )
    }
    return this.settle('error', lastLine(r.stderr) ?? `kubelogin exited ${r.code}`)
  }

  private async doLogin(): Promise<AuthState> {
    const args = await this.execArgs(true)
    if (!args) return this.noExecArgsState()
    this.expiryCache = undefined
    // A refresh that landed while we queued behind the lock makes this a no-op.
    if (this.tokenFresh(TOKEN_MARGIN_MS)) return this.settle('ok', undefined)

    const r = await this.loginRunner(
      args[0] as string,
      [...args.slice(1), '--skip-open-browser'],
      { timeoutMs: this.loginTimeoutMs },
      (line) => {
        const url = line.match(/https?:\/\/[^\s]+/)?.[0]
        if (!url) return
        this.loginUrl = url.replace(/[),.;]+$/, '')
        this.settle('logging_in', 'open the sign-in URL to continue')
      },
    )
    this.expiryCache = undefined
    if (r.code === 0) {
      this.loginUrl = undefined
      return this.settle('ok', undefined)
    }
    const detail = lastLine(r.stderr)
    const message = detail ? `login did not complete: ${detail}` : 'login did not complete'
    return this.settle('login_required', `${message} — ${OFF_NETWORK_HINT}`)
  }

  /** [command, ...args] of the active kubeconfig oidc-login exec plugin, or
   *  null when the inspected context definitively does not use one. Inspection
   *  errors fail closed as an auth error. */
  private async execArgs(force = false): Promise<string[] | null> {
    const cached = this.execArgsCache
    if (!force && cached && Date.now() - cached.at < EXEC_ARGS_TTL_MS) return cached.args
    const previousOidc = this.oidc
    const previousIdentity = this.identity
    let args: string[] | null = null
    let inspected = false
    const r = await this.runner('kubectl', ['config', 'view', '--minify', '-o', 'json']).catch(
      () => undefined,
    )
    if (r && r.code === 0) {
      try {
        const cfg = JSON.parse(r.stdout) as {
          users?: Array<{ user?: { exec?: { command?: string; args?: string[] } } }>
        }
        for (const u of cfg.users ?? []) {
          const exec = u.user?.exec
          if (exec?.command && (exec.args ?? []).includes('oidc-login')) {
            args = [exec.command, ...(exec.args ?? [])]
            break
          }
        }
        inspected = true
      } catch {
        inspected = false
      }
    }
    if (!inspected) {
      this.execArgsCache = { args: null, at: Date.now() }
      this.oidc = true
      this.identity = undefined
      this.expiryCache = undefined
      this.phase = 'error'
      this.message = 'could not inspect the active Kubernetes auth context'
      this.checkedAt = Date.now()
      return null
    }
    const nextOidc = args !== null
    const nextIdentity = args ? execIdentity(args) : undefined
    const changed =
      cached !== undefined &&
      (previousOidc !== nextOidc || identityKey(previousIdentity) !== identityKey(nextIdentity))
    this.execArgsCache = { args, at: Date.now() }
    this.oidc = nextOidc
    this.identity = nextIdentity
    this.expiryCache = undefined
    if (changed) {
      this.phase = 'unknown'
      this.message = undefined
      this.loginUrl = undefined
    }
    return args
  }

  private tokenFresh(marginMs: number): boolean {
    const exp = this.tokenExpiresAt()
    return exp !== undefined && exp - marginMs > Date.now()
  }

  private noExecArgsState(): AuthState {
    return this.phase === 'error' ? this.snapshot() : this.settle('ok', undefined)
  }

  /** Latest id_token expiry across kubelogin's cache files — a pure fs read +
   *  JWT payload decode, so the reconcile-loop gate never spawns a process. */
  private tokenExpiresAt(): number | undefined {
    const cached = this.expiryCache
    if (cached && Date.now() - cached.at < this.expiryTtlMs) return cached.expiresAt
    let latest: number | undefined
    try {
      for (const f of readdirSync(this.cacheDir)) {
        if (f.endsWith('.lock')) continue
        try {
          const raw = readFileSync(join(this.cacheDir, f), 'utf8')
          if (!raw.trim()) continue
          const data = JSON.parse(raw) as { id_token?: string }
          const exp = data.id_token ? matchingJwtExpiryMs(data.id_token, this.identity) : undefined
          if (exp !== undefined && (latest === undefined || exp > latest)) latest = exp
        } catch {
          // an unreadable cache entry is just not evidence of a fresh token
        }
      }
    } catch {
      // no cache dir yet — no token
    }
    this.expiryCache = { expiresAt: latest, at: Date.now() }
    return latest
  }

  private settle(phase: AuthPhase, message: string | undefined): AuthState {
    this.phase = phase
    this.message = message
    this.checkedAt = Date.now()
    return this.snapshot()
  }

  private exclusive(fn: () => Promise<AuthState>): Promise<AuthState> {
    const p = this.lock.then(fn, fn)
    this.lock = p.catch(() => undefined)
    return p
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  if (index >= 0) return args[index + 1]
  return args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1)
}

function execIdentity(args: string[]): { issuer: string; clientId: string } | undefined {
  const issuer = flagValue(args, '--oidc-issuer-url')
  const clientId = flagValue(args, '--oidc-client-id')
  return issuer && clientId ? { issuer: issuer.replace(/\/$/, ''), clientId } : undefined
}

function identityKey(identity: { issuer: string; clientId: string } | undefined): string {
  return identity ? `${identity.issuer}\0${identity.clientId}` : ''
}

function matchingJwtExpiryMs(
  token: string,
  identity: { issuer: string; clientId: string } | undefined,
): number | undefined {
  if (!identity) return undefined
  const payload = token.split('.')[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown
      iss?: unknown
      aud?: unknown
    }
    const issuer = typeof claims.iss === 'string' ? claims.iss.replace(/\/$/, '') : undefined
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (issuer !== identity.issuer || !audiences.includes(identity.clientId)) return undefined
    return typeof claims.exp === 'number' ? claims.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/** The last non-empty line of a command's stderr — kubelogin puts the useful
 *  error there, after a wall of log noise. */
function lastLine(text: string): string | undefined {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return lines[lines.length - 1]
}

/** The `exp` claim of a JWT as epoch ms, without verifying anything — this is
 *  a local staleness hint, not a trust decision (the API server verifies). */
export function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split('.')[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown
    }
    return typeof claims.exp === 'number' ? claims.exp * 1000 : undefined
  } catch {
    return undefined
  }
}
