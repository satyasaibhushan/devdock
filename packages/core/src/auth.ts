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
//  - silent refresh is the daemon's own refresh_token grant against the
//    issuer, written back into kubelogin's cache — never a kubelogin spawn.
//    kubelogin falls back to its browser flow on ANY refresh failure, so a
//    Wi-Fi blip after wake used to read as "login required" until clicked.
//    Here only a rejected grant (invalid_grant) needs a login; transport
//    trouble is retried with backoff (refresh works from any network — only
//    the interactive Google page is IP-restricted to the office);
//  - explicit login is single-flight and uses `--skip-open-browser`; its URL is
//    surfaced to the UI/MCP for a deliberate user click;
//  - kubectl calls are refused while login is required (see kubectlAllowed),
//    so the 5s reconcile loop can't trigger login storms.
import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type RunOptions, type RunResult, run, runStream } from './exec.js'
import { type OidcEndpoints, TokenEndpointError, discoverEndpoints, tokenGrant } from './oidc.js'

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
  /** Pending AWS sign-in URL (set by the service from AwsCreds, not by this
   *  manager): the refresh token is dead and a verb is waiting on it. */
  awsLoginUrl?: string
  checkedAt: number
}

export interface AuthManagerOptions {
  runner?: AuthRunner
  loginRunner?: AuthLoginRunner
  /** kubelogin's token cache — the dir behind `rm -r ~/.kube/cache/oidc-login`. */
  cacheDir?: string
  fetchFn?: typeof fetch
  loginTimeoutMs?: number
  /** How long a cache-dir read is trusted before re-reading (tests set 0). */
  expiryTtlMs?: number
}

/** Consider a token stale this long before its real expiry, so a verb never
 *  starts with a token that dies mid-`devspace deploy`. */
const TOKEN_MARGIN_MS = 60_000
/** Background maintenance renews the token when it has less than this left,
 *  so kubectl/devspace (and their own kubelogin exec) never see a stale one. */
const REFRESH_AHEAD_MS = 20 * 60_000
/** Backoff between silent refreshes after a transport failure. */
const RETRY_BASE_MS = 15_000
const RETRY_MAX_MS = 5 * 60_000
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

interface CacheEntry {
  path: string
  data: { id_token: string; refresh_token?: unknown; [key: string]: unknown }
  expiresAt: number
}

export class AuthManager {
  private readonly runner: AuthRunner
  private readonly loginRunner: AuthLoginRunner
  private readonly cacheDir: string
  private readonly fetchFn: typeof fetch
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
  /** Set while a transport failure waits out its backoff; phase is 'error'. */
  private retryAt: number | undefined
  private failures = 0
  private endpointsCache: { issuer: string; endpoints: OidcEndpoints } | undefined

  private execArgsCache: { args: string[] | null; at: number } | undefined
  private expiryCache: { entry: CacheEntry | undefined; at: number } | undefined

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
    this.fetchFn = opts.fetchFn ?? fetch
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
    if (this.settledFailure()) return this.snapshot()
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
   *  Once the phase is login_required/error, no more probes are kicked from
   *  here: a dead refresh token cannot be fixed silently. A transport failure
   *  is the exception — it is re-probed once its backoff has elapsed. */
  kubectlAllowed(args: string[]): boolean {
    const sub = args[0]
    if (sub === 'config' || sub === 'oidc-login') return true
    if (this.oidc !== true) return true
    if (this.tokenFresh(TOKEN_MARGIN_MS)) return true
    if (!this.settledFailure()) void this.probe().catch(() => undefined)
    return false
  }

  /** Silent freshness check. It never starts an interactive login and never
   *  retries a settled failure; only login() may do that. */
  async ensure(): Promise<AuthState> {
    if (this.oidc === undefined) await this.execArgs()
    if (this.phase === 'error' && !this.retryDue()) return this.snapshot()
    if (this.oidc !== true) return this.settle('ok', undefined)
    if (this.tokenFresh(TOKEN_MARGIN_MS)) return this.settle('ok', undefined)
    if (this.phase === 'login_required') return this.snapshot()
    return this.probe()
  }

  /** Silent check-and-refresh: never opens a browser. Joins an in-flight
   *  probe/login instead of stacking a second refresh or kubelogin. */
  probe(): Promise<AuthState> {
    if (this.logging) return this.logging
    if (this.probing) return this.probing
    const p = this.exclusive(() => this.doProbe(TOKEN_MARGIN_MS)).finally(() => {
      this.probing = null
    })
    this.probing = p
    return p
  }

  /** Background maintenance: renew the token before it expires, so the cache
   *  stays warm and kubectl/devspace never see a stale token. Silent. */
  maintain(): Promise<AuthState> {
    if (this.settledFailure()) return Promise.resolve(this.snapshot())
    if (this.logging) return this.logging
    if (this.probing) return this.probing
    const p = this.exclusive(() => this.doProbe(REFRESH_AHEAD_MS)).finally(() => {
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
    // A login owns kubelogin's fixed callback port; a probe may be rewriting
    // the cache. Do not hide that
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

  private async doProbe(marginMs: number): Promise<AuthState> {
    const args = await this.execArgs()
    if (!args) return this.noExecArgsState()
    this.expiryCache = undefined
    if (this.tokenFresh(marginMs)) return this.settle('ok', undefined)

    const entry = this.latestEntry()
    const identity = this.identity
    const refreshToken = entry?.data.refresh_token
    if (!entry || !identity || typeof refreshToken !== 'string' || !refreshToken) {
      return this.settle('login_required', `Kubernetes login required — ${OFF_NETWORK_HINT}`)
    }
    try {
      const { token } = await this.endpoints(identity.issuer)
      const form: Record<string, string> = {
        grant_type: 'refresh_token',
        client_id: identity.clientId,
        refresh_token: refreshToken,
      }
      const secret = flagValue(args, '--oidc-client-secret')
      if (secret) form.client_secret = secret
      const t = await tokenGrant(this.fetchFn, token, form)
      const rotated =
        typeof t.refresh_token === 'string' && t.refresh_token ? t.refresh_token : refreshToken
      if (typeof t.id_token !== 'string' || !t.id_token) {
        if (rotated !== refreshToken)
          writeCacheEntry(entry.path, { ...entry.data, refresh_token: rotated })
        throw new Error('OIDC refresh response is missing an ID token')
      }
      writeCacheEntry(entry.path, { ...entry.data, id_token: t.id_token, refresh_token: rotated })
    } catch (err) {
      if (err instanceof TokenEndpointError && err.invalidGrant) {
        return this.settle('login_required', `Kubernetes sign-in expired — ${OFF_NETWORK_HINT}`)
      }
      return this.retryLater(err)
    }
    this.expiryCache = undefined
    return this.settle('ok', undefined)
  }

  /** A transient refresh failure: keep the refresh token, retry after backoff. */
  private retryLater(err: unknown): AuthState {
    this.failures += 1
    const delay = Math.min(RETRY_BASE_MS * 2 ** (this.failures - 1), RETRY_MAX_MS)
    const detail = err instanceof Error ? err.message : String(err)
    this.settle(
      'error',
      `Kubernetes token refresh failed (${detail}) — retrying in ${Math.round(delay / 1000)}s`,
    )
    this.retryAt = Date.now() + delay
    return this.snapshot()
  }

  private retryDue(): boolean {
    return this.phase === 'error' && this.retryAt !== undefined && Date.now() >= this.retryAt
  }

  /** A failure only an explicit login (or a due retry) may move past. */
  private settledFailure(): boolean {
    return this.phase === 'login_required' || (this.phase === 'error' && !this.retryDue())
  }

  private async endpoints(issuer: string): Promise<OidcEndpoints> {
    if (this.endpointsCache?.issuer === issuer) return this.endpointsCache.endpoints
    const endpoints = await discoverEndpoints(
      this.fetchFn,
      `${issuer}/.well-known/openid-configuration`,
    )
    this.endpointsCache = { issuer, endpoints }
    return endpoints
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
      this.retryAt = undefined
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

  private tokenExpiresAt(): number | undefined {
    return this.latestEntry()?.expiresAt
  }

  private tokenFresh(marginMs: number): boolean {
    const exp = this.tokenExpiresAt()
    return exp !== undefined && exp - marginMs > Date.now()
  }

  private noExecArgsState(): AuthState {
    return this.phase === 'error' ? this.snapshot() : this.settle('ok', undefined)
  }

  /** The kubelogin cache entry holding the latest id_token for the active
   *  identity — a pure fs read + JWT payload decode, so the reconcile-loop gate
   *  never spawns a process. */
  private latestEntry(): CacheEntry | undefined {
    const cached = this.expiryCache
    if (cached && Date.now() - cached.at < this.expiryTtlMs) return cached.entry
    let latest: CacheEntry | undefined
    try {
      for (const f of readdirSync(this.cacheDir)) {
        if (f.endsWith('.lock') || f.endsWith('.tmp')) continue
        try {
          const path = join(this.cacheDir, f)
          const raw = readFileSync(path, 'utf8')
          if (!raw.trim()) continue
          const data = JSON.parse(raw) as CacheEntry['data']
          const exp =
            typeof data.id_token === 'string'
              ? matchingJwtExpiryMs(data.id_token, this.identity)
              : undefined
          if (exp !== undefined && (latest === undefined || exp > latest.expiresAt)) {
            latest = { path, data, expiresAt: exp }
          }
        } catch {
          // an unreadable cache entry is just not evidence of a fresh token
        }
      }
    } catch {
      // no cache dir yet — no token
    }
    this.expiryCache = { entry: latest, at: Date.now() }
    return latest
  }

  private settle(phase: AuthPhase, message: string | undefined): AuthState {
    this.phase = phase
    this.message = message
    this.retryAt = undefined
    if (phase === 'ok') this.failures = 0
    this.checkedAt = Date.now()
    return this.snapshot()
  }

  private exclusive(fn: () => Promise<AuthState>): Promise<AuthState> {
    const p = this.lock.then(fn, fn)
    this.lock = p.catch(() => undefined)
    return p
  }
}

/** Replace a kubelogin cache file atomically (it reads the same file on every
 *  kubectl call), keeping kubelogin's owner-only mode. */
function writeCacheEntry(path: string, data: Record<string, unknown>): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
  renameSync(tmp, path)
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
