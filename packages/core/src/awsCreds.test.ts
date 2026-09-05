import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AwsCreds } from './awsCreds.js'
import type { RunResult } from './exec.js'

// The shape `aws-cli-oidc setup` writes. Port 0 → the callback server picks an
// ephemeral port, so interactive-flow tests never collide with a real 8010.
const OIDC_CONFIG = `cognito-dev:
  aws_federation_role_session_name: aws-cli-oidc-session
  aws_federation_type: oidc
  client_id: client-123
  client_listen_host: localhost
  client_listen_port: "0"
  default_iam_role_arn: arn:aws:iam::1:role/dev-role
  max_session_duration_seconds: "3600"
  oidc_provider_metadata_url: https://idp.example/.well-known/openid-configuration
`

const METADATA_URL = 'https://idp.example/.well-known/openid-configuration'
const AUTHORIZE_URL = 'https://idp.example/oauth2/authorize'
const TOKEN_URL = 'https://idp.example/oauth2/token'
const STS_URL = 'https://sts.test/'

const stsXml = (expiresInMs: number): string => `<AssumeRoleWithWebIdentityResponse>
  <AccessKeyId>AKIA</AccessKeyId>
  <SecretAccessKey>secret</SecretAccessKey>
  <SessionToken>token</SessionToken>
  <Expiration>${new Date(Date.now() + expiresInMs).toISOString()}</Expiration>
</AssumeRoleWithWebIdentityResponse>`

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status })
const metadata = (): Response =>
  json({ authorization_endpoint: AUTHORIZE_URL, token_endpoint: TOKEN_URL })

const ok = (): RunResult => ({ code: 0, stdout: '', stderr: '' })

/** A fetch stub that dispatches on URL and records token-endpoint grants. */
function fakeFetch(handlers: {
  token?: (form: URLSearchParams) => Response
  sts?: (form: URLSearchParams) => Response
}) {
  const grants: URLSearchParams[] = []
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === METADATA_URL) return metadata()
    if (url === TOKEN_URL) {
      const form = new URLSearchParams(String(init?.body))
      grants.push(form)
      return handlers.token?.(form) ?? json({}, 400)
    }
    if (url === STS_URL) {
      const form = new URLSearchParams(String(init?.body))
      return handlers.sts?.(form) ?? new Response(stsXml(3600_000), { status: 200 })
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  return { fetchFn: fetchFn as unknown as typeof fetch, grants }
}

/** A browser-opener that completes the sign-in: parses the authorize URL the
 *  manager built and hits its redirect_uri back with a code, like the real
 *  browser redirect would. */
function fakeBrowser(code = 'auth-code'): ReturnType<typeof vi.fn> {
  return vi.fn(async (_cmd: string, args: string[]) => {
    const url = new URL(args[0] as string)
    const redirect = url.searchParams.get('redirect_uri') as string
    const state = url.searchParams.get('state') as string
    void fetch(`${redirect}/?code=${code}&state=${encodeURIComponent(state)}`)
    return ok()
  })
}

let dir: string
let configPath: string
let tokenFile: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devdock-awscreds-'))
  configPath = join(dir, 'config.yaml')
  tokenFile = join(dir, 'aws-oidc.json')
  writeFileSync(configPath, OIDC_CONFIG)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const make = (
  fetchFn: typeof fetch,
  runner: ReturnType<typeof vi.fn> = vi.fn(async () => ok()),
  extra: Record<string, unknown> = {},
) =>
  new AwsCreds({
    runner: runner as never,
    oidcConfigPath: configPath,
    tokenFile,
    fetchFn,
    stsUrl: STS_URL,
    ...extra,
  })

describe('AwsCreds', () => {
  it('mints silently via the refresh token grant — no browser', async () => {
    writeFileSync(tokenFile, JSON.stringify({ refreshToken: 'rt-1' }))
    const { fetchFn, grants } = fakeFetch({
      token: () => json({ id_token: 'id-1' }),
    })
    const runner = vi.fn(async () => ok())
    const creds = make(fetchFn, runner)
    expect(creds.configured()).toBe(true)

    expect(await creds.warm()).toEqual({ ok: true })
    expect(runner).not.toHaveBeenCalled() // the whole point
    expect(grants[0]?.get('grant_type')).toBe('refresh_token')
    expect(grants[0]?.get('refresh_token')).toBe('rt-1')
    expect(grants[0]?.get('client_id')).toBe('client-123')
    expect(creds.fresh()).toBe(true)

    // known-fresh → no second mint
    await creds.warm()
    expect(grants).toHaveLength(1)
  })

  it('passes the id_token and role config to STS and caches by Expiration', async () => {
    writeFileSync(tokenFile, JSON.stringify({ refreshToken: 'rt-1' }))
    let stsForm: URLSearchParams | undefined
    const { fetchFn } = fakeFetch({
      token: () => json({ id_token: 'id-1' }),
      sts: (form) => {
        stsForm = form
        return new Response(stsXml(5 * 60_000), { status: 200 }) // < 10 min margin
      },
    })
    const creds = make(fetchFn)
    const r = await creds.credential()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.cred.AccessKeyId).toBe('AKIA')
      expect(r.cred.Version).toBe(1)
    }
    expect(stsForm?.get('Action')).toBe('AssumeRoleWithWebIdentity')
    expect(stsForm?.get('RoleArn')).toBe('arn:aws:iam::1:role/dev-role')
    expect(stsForm?.get('RoleSessionName')).toBe('aws-cli-oidc-session')
    expect(stsForm?.get('WebIdentityToken')).toBe('id-1')
    expect(stsForm?.get('DurationSeconds')).toBe('3600')
    expect(creds.fresh()).toBe(false) // near expiry → next warm re-mints
  })

  it('falls back to ONE interactive PKCE login when there is no refresh token', async () => {
    const { fetchFn, grants } = fakeFetch({
      token: (form) =>
        form.get('grant_type') === 'authorization_code'
          ? json({ id_token: 'id-2', refresh_token: 'rt-new' })
          : json({ error: 'invalid_grant' }, 400),
    })
    const runner = fakeBrowser()
    const creds = make(fetchFn, runner)

    expect(await creds.warm()).toEqual({ ok: true })
    expect(runner).toHaveBeenCalledTimes(1)
    const grant = grants.find((g) => g.get('grant_type') === 'authorization_code')
    expect(grant?.get('code')).toBe('auth-code')
    expect(grant?.get('code_verifier')).toBeTruthy()
    // the refresh token is persisted — the next expiry refreshes silently
    expect(JSON.parse(readFileSync(tokenFile, 'utf8')).refreshToken).toBe('rt-new')
  })

  it('burns a dead refresh token (invalid_grant) and goes interactive', async () => {
    writeFileSync(tokenFile, JSON.stringify({ refreshToken: 'rt-dead' }))
    const { fetchFn, grants } = fakeFetch({
      token: (form) =>
        form.get('grant_type') === 'refresh_token'
          ? json({ error: 'invalid_grant' }, 400)
          : json({ id_token: 'id-3', refresh_token: 'rt-live' }),
    })
    const runner = fakeBrowser()
    const creds = make(fetchFn, runner)

    expect(await creds.warm()).toEqual({ ok: true })
    expect(grants.map((g) => g.get('grant_type'))).toEqual(['refresh_token', 'authorization_code'])
    expect(JSON.parse(readFileSync(tokenFile, 'utf8')).refreshToken).toBe('rt-live')
  })

  it('keeps the refresh token on transport failure — no browser fallback', async () => {
    writeFileSync(tokenFile, JSON.stringify({ refreshToken: 'rt-1' }))
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === METADATA_URL) return metadata()
      throw new Error('network is down')
    }) as unknown as typeof fetch
    const runner = vi.fn(async () => ok())
    const creds = make(fetchFn, runner, { failCooldownMs: 0 })

    const r = await creds.warm()
    expect(r.ok).toBe(false)
    expect(r.message).toContain('network is down')
    expect(runner).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(tokenFile, 'utf8')).refreshToken).toBe('rt-1')
  })

  it.each([401, 403, 429, 500, 502, 503])(
    'preserves refresh tokens after HTTP %i and recovers silently',
    async (status) => {
      writeFileSync(tokenFile, JSON.stringify({ refreshToken: 'rt-1' }))
      let failing = true
      const { fetchFn } = fakeFetch({
        token: () =>
          failing ? json({ error: 'temporarily_unavailable' }, status) : json({ id_token: 'id-1' }),
      })
      const runner = vi.fn(async () => ok())
      const creds = make(fetchFn, runner, { failCooldownMs: 0, loginTimeoutMs: 20 })
      expect((await creds.warm()).ok).toBe(false)
      expect(JSON.parse(readFileSync(tokenFile, 'utf8')).refreshToken).toBe('rt-1')
      expect(runner).not.toHaveBeenCalled()
      failing = false
      expect(await creds.warm()).toEqual({ ok: true })
      expect(runner).not.toHaveBeenCalled()
    },
  )

  it('preserves a rotated refresh token when the response is missing an ID token', async () => {
    writeFileSync(tokenFile, JSON.stringify({ refreshToken: 'rt-1' }))
    const { fetchFn } = fakeFetch({ token: () => json({ refresh_token: 'rt-2' }) })
    const runner = vi.fn(async () => ok())
    const creds = make(fetchFn, runner, { loginTimeoutMs: 20 })
    expect((await creds.warm()).ok).toBe(false)
    expect(runner).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(tokenFile, 'utf8')).refreshToken).toBe('rt-2')
  })

  it('single-flights concurrent warms', async () => {
    writeFileSync(tokenFile, JSON.stringify({ refreshToken: 'rt-1' }))
    let release: (r: Response) => void = () => {}
    const gate = new Promise<Response>((res) => {
      release = res
    })
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === METADATA_URL) return metadata()
      if (url === TOKEN_URL) return gate
      return new Response(stsXml(3600_000), { status: 200 })
    }) as unknown as typeof fetch
    const creds = make(fetchFn)

    const [a, b] = [creds.warm(), creds.warm()]
    release(json({ id_token: 'id-1' }))
    expect(await a).toEqual({ ok: true })
    expect(await b).toEqual({ ok: true })
    // one metadata + one token grant + one STS call — not two of each
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3)
  })

  it('reports failure and holds a cooldown before retrying', async () => {
    const { fetchFn } = fakeFetch({
      sts: () => new Response('<Error><Message>role denied</Message></Error>', { status: 403 }),
      token: () => json({ id_token: 'id-1' }),
    })
    writeFileSync(tokenFile, JSON.stringify({ refreshToken: 'rt-1' }))
    const creds = make(
      fetchFn,
      vi.fn(async () => ok()),
      { failCooldownMs: 60_000 },
    )

    const r = await creds.warm()
    expect(r.ok).toBe(false)
    expect(r.message).toContain('role denied')
    // within cooldown: same answer, no re-mint (no surprise browser tabs)
    expect((await creds.warm()).ok).toBe(false)
    const tokenCalls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]) === STS_URL,
    )
    expect(tokenCalls).toHaveLength(1)
  })

  it('recovers after a cooldown expires', async () => {
    writeFileSync(tokenFile, JSON.stringify({ refreshToken: 'rt-1' }))
    let stsCalls = 0
    const { fetchFn } = fakeFetch({
      token: () => json({ id_token: 'id-1' }),
      sts: () =>
        ++stsCalls === 1
          ? new Response('<Error><Message>nope</Message></Error>', { status: 403 })
          : new Response(stsXml(3600_000), { status: 200 }),
    })
    const creds = make(
      fetchFn,
      vi.fn(async () => ok()),
      { failCooldownMs: 0 },
    )
    expect((await creds.warm()).ok).toBe(false)
    expect((await creds.warm()).ok).toBe(true)
  })

  it('is a no-op without an aws-cli-oidc config', async () => {
    for (const path of [null, join(dir, 'nope.yaml')]) {
      const fetchFn = vi.fn() as unknown as typeof fetch
      const creds = new AwsCreds({ oidcConfigPath: path, tokenFile, fetchFn })
      expect(creds.configured()).toBe(false)
      expect(await creds.warm()).toEqual({ ok: true })
      expect((await creds.credential()).ok).toBe(false)
      expect(fetchFn).not.toHaveBeenCalled()
    }
  })

  it('ignores non-oidc provider entries', async () => {
    writeFileSync(
      configPath,
      'saml-prov:\n  aws_federation_type: saml2\n  client_id: x\n  oidc_provider_metadata_url: y\n  default_iam_role_arn: z\n',
    )
    const creds = make(vi.fn() as unknown as typeof fetch)
    expect(creds.configured()).toBe(false)
  })

  it('clearTokens forgets the refresh token and the minted credential', async () => {
    writeFileSync(tokenFile, JSON.stringify({ refreshToken: 'rt-1' }))
    const { fetchFn } = fakeFetch({ token: () => json({ id_token: 'id-1' }) })
    const creds = make(fetchFn)
    await creds.warm()
    expect(creds.fresh()).toBe(true)
    creds.clearTokens()
    expect(creds.fresh()).toBe(false)
    expect(() => readFileSync(tokenFile, 'utf8')).toThrow()
  })
})
