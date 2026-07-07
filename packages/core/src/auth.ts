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
//  - interactive login is single-flight: concurrent verbs all await the same
//    attempt, so starting five repos unauthenticated yields ONE browser tab;
//  - kubectl calls are refused while login is required (see kubectlAllowed),
//    so the 5s reconcile loop can't trigger login storms.
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type RunOptions, type RunResult, run } from './exec.js'

/** Runner with timeout support — auth probes MUST be killable (a kubelogin
 *  waiting for a browser callback would otherwise hang the daemon forever). */
export type AuthRunner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>

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
  checkedAt: number
}

export interface AuthManagerOptions {
  runner?: AuthRunner
  /** kubelogin's token cache — the dir behind `rm -r ~/.kube/cache/oidc-login`. */
  cacheDir?: string
  probeTimeoutMs?: number
  loginTimeoutMs?: number
  /** After a failed interactive login, ensure() won't auto-open the browser
   *  again for this long — an explicit login() always may. */
  loginCooldownMs?: number
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
const LOGIN_COOLDOWN_MS = 60_000
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

export class AuthManager {
  private readonly runner: AuthRunner
  private readonly cacheDir: string
  private readonly probeTimeoutMs: number
  private readonly loginTimeoutMs: number
  private readonly loginCooldownMs: number
  private readonly expiryTtlMs: number

  /** undefined = kubeconfig not inspected yet (gate stays open — pre-init
   *  behaviour is exactly the old, ungated devdock). */
  private oidc: boolean | undefined
  private phase: AuthPhase = 'unknown'
  private message: string | undefined
  private checkedAt = 0
  private lastLoginFailAt = 0

  private execArgsCache: { args: string[] | null; at: number } | undefined
  private expiryCache: { expiresAt: number | undefined; at: number } | undefined

  /** Serializes probe/refresh/login — kubelogin binds a fixed localhost port,
   *  so two live instances always fight. */
  private lock: Promise<unknown> = Promise.resolve()
  private probing: Promise<AuthState> | null = null
  private logging: Promise<AuthState> | null = null

  constructor(opts: AuthManagerOptions = {}) {
    this.runner = opts.runner ?? run
    this.cacheDir = opts.cacheDir ?? join(homedir(), '.kube', 'cache', 'oidc-login')
    this.probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS
    this.loginTimeoutMs = opts.loginTimeoutMs ?? LOGIN_TIMEOUT_MS
    this.loginCooldownMs = opts.loginCooldownMs ?? LOGIN_COOLDOWN_MS
    this.expiryTtlMs = opts.expiryTtlMs ?? EXPIRY_TTL_MS
  }

  snapshot(): AuthState {
    return {
      oidc: this.oidc === true,
      phase: this.oidc === false ? 'ok' : this.phase,
      message: this.message,
      tokenExpiresAt: this.tokenExpiresAt(),
      checkedAt: this.checkedAt,
    }
  }

  /** Inspect the kubeconfig once at boot and settle the initial phase. */
  async init(): Promise<AuthState> {
    const args = await this.execArgs()
    if (!args) return this.settle('ok', undefined)
    return this.probe()
  }

  /** Whether this kubectl invocation may run right now. `config`/`oidc-login`
   *  subcommands are local (no API server, no token) and always pass. API
   *  calls pass only on a fresh cached token — otherwise a silent refresh is
   *  kicked off (single-flight) and the call is refused, so a stale token can
   *  never fan out into per-process kubelogin browser storms. */
  kubectlAllowed(args: string[]): boolean {
    const sub = args[0]
    if (sub === 'config' || sub === 'oidc-login') return true
    if (this.oidc !== true) return true
    if (this.tokenFresh(TOKEN_MARGIN_MS)) return true
    void this.probe().catch(() => undefined)
    return false
  }

  /** Make auth good before a lifecycle verb: fresh cache → done; else silent
   *  refresh; else (when `interactive`) ONE shared browser login. Concurrent
   *  callers coalesce — that's the whole point. */
  async ensure(interactive = true): Promise<AuthState> {
    if (this.oidc === undefined) await this.execArgs()
    if (this.oidc !== true) return this.settle('ok', undefined)
    if (this.tokenFresh(TOKEN_MARGIN_MS)) return this.settle('ok', undefined)
    const probed = await this.probe()
    if (probed.phase !== 'login_required' || !interactive) return probed
    if (Date.now() - this.lastLoginFailAt < this.loginCooldownMs) {
      return this.settle(
        'login_required',
        this.message ?? `a login attempt just failed — ${OFF_NETWORK_HINT}`,
      )
    }
    return this.login()
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
    if (this.logging) return this.logging
    if (this.probing) return this.probing
    const p = this.exclusive(() => this.doProbe(true, REFRESH_AHEAD_MS)).finally(() => {
      this.probing = null
    })
    this.probing = p
    return p
  }

  /** Interactive login — opens the browser (once). Explicit calls (the UI's
   *  Login button) always run; ensure() applies a cooldown after failures. */
  login(): Promise<AuthState> {
    if (this.logging) return this.logging
    const p = this.exclusive(() => this.doLogin()).finally(() => {
      this.logging = null
    })
    this.logging = p
    return p
  }

  /** `rm -r ~/.kube/cache/oidc-login` as a button. */
  clearCache(): AuthState {
    rmSync(this.cacheDir, { recursive: true, force: true })
    this.expiryCache = undefined
    if (this.oidc === true) {
      return this.settle('login_required', 'auth cache cleared — log in again')
    }
    return this.snapshot()
  }

  // ---- internals ----

  private async doProbe(forceRefresh: boolean, marginMs: number): Promise<AuthState> {
    const args = await this.execArgs()
    if (!args) return this.settle('ok', undefined)
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
    return this.settle('error', lastLine(r.stderr) ?? `kubelogin exited ${r.code}`)
  }

  private async doLogin(): Promise<AuthState> {
    const args = await this.execArgs()
    if (!args) return this.settle('ok', undefined)
    this.expiryCache = undefined
    // A refresh that landed while we queued behind the lock makes this a no-op.
    if (this.tokenFresh(TOKEN_MARGIN_MS)) return this.settle('ok', undefined)

    this.settle('logging_in', 'complete the Google sign-in in your browser')
    const r = await this.runner(args[0] as string, args.slice(1), {
      timeoutMs: this.loginTimeoutMs,
    })
    this.expiryCache = undefined
    if (r.code === 0) {
      this.lastLoginFailAt = 0
      return this.settle('ok', undefined)
    }
    this.lastLoginFailAt = Date.now()
    return this.settle('login_required', `login did not complete — ${OFF_NETWORK_HINT}`)
  }

  /** [command, ...args] of the kubeconfig's oidc-login exec plugin, or null
   *  when the current context doesn't use one. Errors and unparseable output
   *  read as "no oidc" — devdock then behaves exactly as before this existed. */
  private async execArgs(): Promise<string[] | null> {
    const cached = this.execArgsCache
    if (cached && Date.now() - cached.at < EXEC_ARGS_TTL_MS) return cached.args
    let args: string[] | null = null
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
      } catch {
        args = null
      }
    }
    this.execArgsCache = { args, at: Date.now() }
    this.oidc = args !== null
    return args
  }

  private tokenFresh(marginMs: number): boolean {
    const exp = this.tokenExpiresAt()
    return exp !== undefined && exp - marginMs > Date.now()
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
          const exp = data.id_token ? jwtExpiryMs(data.id_token) : undefined
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
