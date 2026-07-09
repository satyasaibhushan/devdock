// awsCreds — the daemon-side owner of the AWS/ECR credential.
//
// Why this exists: repos' devspace.yaml evaluates `aws ecr get-login-password`
// at config load. That used to route through aws-cli-oidc, which discards the
// OIDC refresh token Cognito hands it and falls back to an interactive browser
// login on a FIXED localhost port whenever its cached credential expires — so
// a browser tab popped every hour, and parallel devspace boots raced the port
// and died. The daemon now owns the credential end to end:
//
//  - silent path: Cognito refresh_token grant → sts:AssumeRoleWithWebIdentity
//    (an UNSIGNED STS call, so no prior credential is needed) — no browser,
//    works from any network;
//  - interactive path (first login, or the refresh token expired): ONE
//    single-flight PKCE authorization-code flow on the registered localhost
//    port, same cure AuthManager applies to kubelogin/8040;
//  - the aws profile's credential_process points at the devdock-aws-cred shim,
//    which asks the daemon over HTTP — every aws/devspace/docker process reads
//    the daemon-minted credential and can never trigger its own login.
//
// Provider settings (client id, metadata URL, role ARN…) are read from the
// aws-cli-oidc config that already exists on every teammate's machine, so
// there is nothing new to configure.
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { type AuthRunner, OFF_NETWORK_HINT } from './auth.js'
import { run } from './exec.js'

export interface WarmResult {
  ok: boolean
  /** Why warming failed — surfaced into the workload's log hub. */
  message?: string
}

/** A credential_process payload — what `/aws/credential` serves. */
export interface AwsCredential {
  Version: 1
  AccessKeyId: string
  SecretAccessKey: string
  SessionToken: string
  Expiration: string
}

export interface AwsCredsOptions {
  /** Used only to open the browser for the interactive flow. */
  runner?: AuthRunner
  /** The aws-cli-oidc yaml describing the OIDC provider. `null` disables the
   *  manager entirely (tests, machines without this setup). */
  oidcConfigPath?: string | null
  /** Where the OIDC refresh token persists across daemon restarts. */
  tokenFile?: string
  fetchFn?: typeof fetch
  loginTimeoutMs?: number
  failCooldownMs?: number
  stsUrl?: string
}

/** Refresh when the stored credential has less than this left, so a devspace
 *  spawned right before expiry never sees it die mid-deploy. */
const EXPIRY_MARGIN_MS = 10 * 60_000
/** A minted credential whose Expiration didn't parse is trusted this long. */
const FALLBACK_FRESH_MS = 10 * 60_000
/** The interactive flow (browser + Cognito) needs human time; give up after
 *  this so a verb can't hang forever on a sign-in nobody completes. */
const LOGIN_TIMEOUT_MS = 190_000
/** After a failed mint, don't re-run (and re-open a browser tab) for this
 *  long — reconcile-driven reconnect attempts would otherwise storm it. */
const FAIL_COOLDOWN_MS = 60_000
/** Every non-interactive HTTP hop (metadata, token grant, STS). */
const HTTP_TIMEOUT_MS = 30_000
/** Global endpoint — role credentials are region-agnostic. */
const STS_URL = 'https://sts.amazonaws.com/'

interface ProviderConfig {
  name: string
  clientId: string
  metadataUrl: string
  listenHost: string
  listenPort: number
  roleArn: string
  sessionName: string
  durationSeconds: number
}

interface TokenResponse {
  id_token?: string
  refresh_token?: string
}

/** An OAuth error response from the token endpoint (bad/expired grant) — as
 *  opposed to transport trouble, which must NOT burn the refresh token. */
class TokenEndpointError extends Error {}

export class AwsCreds {
  private readonly runner: AuthRunner
  private readonly oidcConfigPath: string | null
  private readonly tokenFile: string
  private readonly fetchFn: typeof fetch
  private readonly loginTimeoutMs: number
  private readonly failCooldownMs: number
  private readonly stsUrl: string

  /** undefined = config not inspected yet; null = no usable provider entry. */
  private cfg: ProviderConfig | null | undefined
  private endpointsCache: { authorize: string; token: string } | undefined
  private cred: AwsCredential | undefined
  private expiresAt = 0
  private lastFailAt = 0
  private lastFailMessage: string | undefined
  private inflight: Promise<WarmResult> | null = null

  constructor(opts: AwsCredsOptions = {}) {
    this.runner = opts.runner ?? run
    this.oidcConfigPath =
      opts.oidcConfigPath === undefined
        ? join(homedir(), '.aws-cli-oidc', 'config.yaml')
        : opts.oidcConfigPath
    this.tokenFile = opts.tokenFile ?? join(homedir(), '.devdock', 'aws-oidc.json')
    this.fetchFn = opts.fetchFn ?? fetch
    this.loginTimeoutMs = opts.loginTimeoutMs ?? LOGIN_TIMEOUT_MS
    this.failCooldownMs = opts.failCooldownMs ?? FAIL_COOLDOWN_MS
    this.stsUrl = opts.stsUrl ?? STS_URL
  }

  /** Whether this machine has an aws-cli-oidc provider configured at all. */
  configured(): boolean {
    return this.config() !== null
  }

  /** Whether the minted credential is known-fresh (a warm would be a no-op). */
  fresh(): boolean {
    return this.expiresAt - EXPIRY_MARGIN_MS > Date.now()
  }

  /** Make the AWS credential good before devspace runs. Single-flight: every
   *  concurrent caller awaits the same mint, so at most ONE refresh runs and
   *  at most ONE browser tab ever opens. */
  warm(): Promise<WarmResult> {
    if (this.inflight) return this.inflight
    const p = this.doWarm().finally(() => {
      this.inflight = null
    })
    this.inflight = p
    return p
  }

  /** The credential_process payload for `/aws/credential` (and thus the
   *  devdock-aws-cred shim in ~/.aws/config). Warms first, so answering may
   *  take one silent refresh — or one shared browser sign-in. */
  async credential(): Promise<{ ok: true; cred: AwsCredential } | { ok: false; message: string }> {
    if (!this.configured()) {
      return { ok: false, message: `no OIDC provider found in ${this.oidcConfigPath}` }
    }
    const r = await this.warm()
    if (!r.ok || !this.cred) {
      return { ok: false, message: r.message ?? 'credential refresh failed' }
    }
    return { ok: true, cred: this.cred }
  }

  /** Forget the persisted refresh token — the next warm is interactive. */
  clearTokens(): void {
    rmSync(this.tokenFile, { force: true })
    this.cred = undefined
    this.expiresAt = 0
    this.lastFailAt = 0
  }

  // ---- internals ----

  private async doWarm(): Promise<WarmResult> {
    const cfg = this.config()
    if (!cfg) return { ok: true } // no aws-cli-oidc setup — nothing to warm
    if (this.fresh()) return { ok: true }
    if (Date.now() - this.lastFailAt < this.failCooldownMs) {
      return { ok: false, message: this.lastFailMessage ?? 'a credential refresh just failed' }
    }
    try {
      const cred = await this.mint(cfg)
      const exp = Date.parse(cred.Expiration)
      this.cred = cred
      this.expiresAt = Number.isNaN(exp) ? Date.now() + FALLBACK_FRESH_MS : exp
      this.lastFailAt = 0
      this.lastFailMessage = undefined
      return { ok: true }
    } catch (err) {
      this.lastFailAt = Date.now()
      this.lastFailMessage = err instanceof Error ? err.message : String(err)
      return { ok: false, message: this.lastFailMessage }
    }
  }

  private async mint(cfg: ProviderConfig): Promise<AwsCredential> {
    const ep = await this.discover(cfg)
    let idToken: string | undefined
    const refreshToken = this.loadRefreshToken()
    if (refreshToken) {
      try {
        const t = await this.tokenGrant(ep.token, {
          grant_type: 'refresh_token',
          client_id: cfg.clientId,
          refresh_token: refreshToken,
        })
        if (t.refresh_token) this.saveRefreshToken(t.refresh_token) // rotation, if enabled
        idToken = t.id_token
      } catch (err) {
        if (!(err instanceof TokenEndpointError)) throw err
        // The grant is dead (expired/revoked) — only then fall to the browser.
        rmSync(this.tokenFile, { force: true })
      }
    }
    if (!idToken) idToken = await this.interactiveLogin(cfg, ep)
    return this.assumeRole(cfg, idToken)
  }

  /** PKCE authorization-code flow: local callback server on the REGISTERED
   *  host/port (the redirect_uri must match the app client exactly), one
   *  browser tab, code → tokens. The refresh token is persisted so this runs
   *  again only when that token dies (~monthly), not hourly. */
  private async interactiveLogin(
    cfg: ProviderConfig,
    ep: { authorize: string; token: string },
  ): Promise<string> {
    const verifier = randomBytes(64).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(16).toString('base64url')

    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', (err) => {
        reject(
          (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
            ? new Error(
                `port ${cfg.listenPort} is busy — another sign-in may already be in progress`,
              )
            : err,
        )
      })
      server.listen(cfg.listenPort, cfg.listenHost, resolve)
    })
    try {
      const port = (server.address() as AddressInfo).port
      const redirect = `http://${cfg.listenHost}:${port}`
      const code = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`AWS sign-in did not complete in time — ${OFF_NETWORK_HINT}`))
        }, this.loginTimeoutMs)
        server.on('request', (req, res) => {
          const u = new URL(req.url ?? '/', redirect)
          const got = u.searchParams.get('code')
          const ok = Boolean(got) && u.searchParams.get('state') === state
          res.writeHead(ok ? 200 : 400, {
            'content-type': 'text/html',
            'cache-control': 'no-store',
          })
          res.end(
            ok
              ? '<body>devdock: AWS sign-in complete — you can close this tab.</body>'
              : '<body>devdock: sign-in failed.</body>',
          )
          if (ok && got) {
            clearTimeout(timer)
            resolve(got)
          }
        })
      })
      const url = `${ep.authorize}?${new URLSearchParams({
        response_type: 'code',
        client_id: cfg.clientId,
        redirect_uri: redirect,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'openid',
        state,
      })}`
      const opened = await this.runner(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
        timeoutMs: 10_000,
      })
      if (opened.code > 0) {
        throw new Error(`could not open a browser for the AWS sign-in (exit ${opened.code})`)
      }
      const tokens = await this.tokenGrant(ep.token, {
        grant_type: 'authorization_code',
        client_id: cfg.clientId,
        code: await code,
        code_verifier: verifier,
        redirect_uri: redirect,
      })
      if (tokens.refresh_token) this.saveRefreshToken(tokens.refresh_token)
      if (!tokens.id_token) throw new Error('sign-in succeeded but returned no id_token')
      return tokens.id_token
    } finally {
      server.close()
    }
  }

  /** sts:AssumeRoleWithWebIdentity — unsigned, so it needs no credential. */
  private async assumeRole(cfg: ProviderConfig, idToken: string): Promise<AwsCredential> {
    const form = new URLSearchParams({
      Action: 'AssumeRoleWithWebIdentity',
      Version: '2011-06-15',
      RoleArn: cfg.roleArn,
      RoleSessionName: cfg.sessionName,
      WebIdentityToken: idToken,
      DurationSeconds: String(cfg.durationSeconds),
    })
    const res = await this.fetchFn(this.stsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    const xml = await res.text()
    if (!res.ok) {
      throw new Error(xmlValue(xml, 'Message') ?? `STS AssumeRoleWithWebIdentity failed (${res.status})`)
    }
    return {
      Version: 1,
      AccessKeyId: need(xml, 'AccessKeyId'),
      SecretAccessKey: need(xml, 'SecretAccessKey'),
      SessionToken: need(xml, 'SessionToken'),
      Expiration: need(xml, 'Expiration'),
    }
  }

  private async tokenGrant(tokenUrl: string, form: Record<string, string>): Promise<TokenResponse> {
    const res = await this.fetchFn(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    const body = (await res.json().catch(() => ({}))) as TokenResponse & {
      error?: string
      error_description?: string
    }
    if (!res.ok) {
      throw new TokenEndpointError(
        `OIDC token grant failed: ${body.error_description ?? body.error ?? `status ${res.status}`}`,
      )
    }
    return body
  }

  /** authorize/token endpoints from the provider's metadata URL, fetched once. */
  private async discover(cfg: ProviderConfig): Promise<{ authorize: string; token: string }> {
    if (this.endpointsCache) return this.endpointsCache
    const res = await this.fetchFn(cfg.metadataUrl, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`OIDC metadata fetch failed (${res.status})`)
    const meta = (await res.json()) as { authorization_endpoint?: unknown; token_endpoint?: unknown }
    if (typeof meta.authorization_endpoint !== 'string' || typeof meta.token_endpoint !== 'string') {
      throw new Error('OIDC metadata is missing its endpoints')
    }
    this.endpointsCache = { authorize: meta.authorization_endpoint, token: meta.token_endpoint }
    return this.endpointsCache
  }

  private loadRefreshToken(): string | undefined {
    try {
      const data = JSON.parse(readFileSync(this.tokenFile, 'utf8')) as { refreshToken?: unknown }
      return typeof data.refreshToken === 'string' && data.refreshToken ? data.refreshToken : undefined
    } catch {
      return undefined
    }
  }

  private saveRefreshToken(token: string): void {
    mkdirSync(dirname(this.tokenFile), { recursive: true })
    writeFileSync(this.tokenFile, JSON.stringify({ refreshToken: token, savedAt: Date.now() }), {
      mode: 0o600,
    })
  }

  /** The first OIDC-federated provider entry of the aws-cli-oidc config.
   *  Missing file/entry → null (manager is a permanent no-op — machines
   *  without this setup behave exactly as before). */
  private config(): ProviderConfig | null {
    if (this.cfg !== undefined) return this.cfg
    this.cfg = null
    if (this.oidcConfigPath) {
      try {
        const doc = parseFlatYaml(readFileSync(this.oidcConfigPath, 'utf8'))
        for (const [name, p] of Object.entries(doc)) {
          if ((p.aws_federation_type ?? 'oidc') !== 'oidc') continue
          if (!p.client_id || !p.oidc_provider_metadata_url || !p.default_iam_role_arn) continue
          this.cfg = {
            name,
            clientId: p.client_id,
            metadataUrl: p.oidc_provider_metadata_url,
            listenHost: p.client_listen_host || 'localhost',
            listenPort: Number(p.client_listen_port ?? 8010),
            roleArn: p.default_iam_role_arn,
            sessionName: p.aws_federation_role_session_name || 'devdock',
            durationSeconds: Number(p.max_session_duration_seconds) || 3600,
          }
          break
        }
      } catch {
        // unreadable config is just not evidence of an aws-cli-oidc setup
      }
    }
    return this.cfg
  }
}

/** Minimal parser for aws-cli-oidc's config.yaml: provider name → flat string
 *  map. Not general YAML — exactly the shape `aws-cli-oidc setup` writes
 *  (two-space indent, scalar values, optional double quotes). */
function parseFlatYaml(text: string): Record<string, Record<string, string>> {
  const doc: Record<string, Record<string, string>> = {}
  let current: Record<string, string> | undefined
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const top = raw.match(/^([\w][\w.-]*):\s*$/)
    if (top?.[1]) {
      current = {}
      doc[top[1]] = current
      continue
    }
    const kv = raw.match(/^\s+([\w][\w.-]*):\s*(.*)$/)
    if (kv?.[1] && current) current[kv[1]] = unquote(kv[2] ?? '')
  }
  return doc
}

const unquote = (v: string): string => v.replace(/^"(.*)"$/s, '$1')

function xmlValue(xml: string, tag: string): string | undefined {
  return xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1]
}

function need(xml: string, tag: string): string {
  const v = xmlValue(xml, tag)
  if (!v) throw new Error(`STS response is missing ${tag}`)
  return v
}
