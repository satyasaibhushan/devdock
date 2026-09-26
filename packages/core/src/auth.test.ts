import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthManager, jwtExpiryMs } from './auth.js'
import type { RunResult } from './exec.js'

const OIDC_CONFIG = JSON.stringify({
  users: [
    {
      name: 'oidc-user',
      user: {
        exec: {
          command: 'kubectl',
          args: [
            'oidc-login',
            'get-token',
            '--oidc-issuer-url=https://issuer.example',
            '--oidc-client-id=abc',
            '--listen-address=localhost:8040',
          ],
        },
      },
    },
  ],
})

const PLAIN_CONFIG = JSON.stringify({
  users: [{ name: 'u', user: { token: 'static' } }],
})

/** A JWT whose payload carries the given expiry — signature is irrelevant,
 *  jwtExpiryMs only decodes the middle segment. */
function makeToken(
  expiresInMs: number,
  identity: { iss: string; aud: string | string[] } = {
    iss: 'https://issuer.example',
    aud: 'abc',
  },
): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor((Date.now() + expiresInMs) / 1000), ...identity }),
  ).toString('base64url')
  return `h.${payload}.s`
}

let cacheDir: string
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'devdock-auth-'))
})
afterEach(() => rmSync(cacheDir, { recursive: true, force: true }))

function writeCachedToken(
  expiresInMs: number,
  identity?: { iss: string; aud: string | string[] },
): void {
  writeFileSync(
    join(cacheDir, 'entry'),
    JSON.stringify({ id_token: makeToken(expiresInMs, identity), refresh_token: 'r' }),
  )
}

type Handler = (cmd: string, args: string[]) => RunResult | Promise<RunResult>
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' })

const METADATA_URL = 'https://issuer.example/.well-known/openid-configuration'
const TOKEN_URL = 'https://issuer.example/oauth2/token'
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status })

/** The issuer: metadata plus a token endpoint answering refresh grants with
 *  `onGrant`. By default every grant is rejected as a dead refresh token. */
function fakeIssuer(
  onGrant: (form: URLSearchParams) => Response | Promise<Response> = () =>
    json({ error: 'invalid_grant' }, 400),
) {
  const grants: URLSearchParams[] = []
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === METADATA_URL) {
      return json({
        authorization_endpoint: 'https://issuer.example/authorize',
        token_endpoint: TOKEN_URL,
      })
    }
    if (url === TOKEN_URL) {
      const form = new URLSearchParams(String(init?.body))
      grants.push(form)
      return onGrant(form)
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  return { fetchFn: fetchFn as unknown as typeof fetch, grants }
}

const cached = () => JSON.parse(readFileSync(join(cacheDir, 'entry'), 'utf8'))

/** Routes `kubectl config view` to the given kubeconfig; everything else to `onExec`. */
function fakeRunner(kubeconfigJson: string, onExec: Handler = () => ok()) {
  return vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
    if (cmd === 'kubectl' && args[0] === 'config') return ok(kubeconfigJson)
    return onExec(cmd, args)
  })
}

describe('jwtExpiryMs', () => {
  it('decodes the exp claim to epoch ms', () => {
    const exp = jwtExpiryMs(makeToken(60_000))
    expect(exp).toBeDefined()
    expect(Math.abs((exp as number) - (Date.now() + 60_000))).toBeLessThan(2000)
  })

  it('returns undefined for garbage', () => {
    expect(jwtExpiryMs('not-a-jwt')).toBeUndefined()
    expect(jwtExpiryMs('a.%%%.c')).toBeUndefined()
  })
})

describe('AuthManager', () => {
  it('is a no-op for kubeconfigs without oidc-login', async () => {
    const runner = fakeRunner(PLAIN_CONFIG)
    const auth = new AuthManager({ runner, cacheDir })
    const s = await auth.init()
    expect(s.oidc).toBe(false)
    expect(s.phase).toBe('ok')
    expect(auth.kubectlAllowed(['get', 'pods'])).toBe(true)
    // only the config view ran — no probe, no login
    expect(runner.mock.calls.every((c) => c[1][0] === 'config')).toBe(true)
  })

  it('fails closed when the active kube context cannot be inspected', async () => {
    const auth = new AuthManager({ runner: fakeRunner(''), cacheDir })
    const s = await auth.ensure()
    expect(s.phase).toBe('error')
    expect(s.oidc).toBe(true)
    expect(auth.kubectlAllowed(['get', 'pods'])).toBe(false)
  })

  it('reports ok from a fresh cached token without spawning kubelogin', async () => {
    writeCachedToken(60 * 60_000)
    const exec = vi.fn(() => ok())
    const auth = new AuthManager({ runner: fakeRunner(OIDC_CONFIG, exec), cacheDir })
    const s = await auth.init()
    expect(s.phase).toBe('ok')
    expect(s.tokenExpiresAt).toBeGreaterThan(Date.now())
    expect(exec).not.toHaveBeenCalled()
  })

  it('ignores a newer cached token from a different issuer or client', async () => {
    writeCachedToken(60 * 60_000, { iss: 'https://other.example', aud: 'other-client' })
    const { fetchFn, grants } = fakeIssuer()
    const auth = new AuthManager({ runner: fakeRunner(OIDC_CONFIG), cacheDir, fetchFn })
    const state = await auth.init()
    expect(state.phase).toBe('login_required')
    expect(state.tokenExpiresAt).toBeUndefined()
    // the other identity's refresh token is never sent to this issuer
    expect(grants).toHaveLength(0)
  })

  it('rechecks the active context instead of trusting the previous context token', async () => {
    writeCachedToken(60 * 60_000)
    let config = OIDC_CONFIG
    const runner = vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
      if (cmd === 'kubectl' && args[0] === 'config') return ok(config)
      return ok()
    })
    const { fetchFn } = fakeIssuer()
    const auth = new AuthManager({ runner, cacheDir, fetchFn })
    expect((await auth.init()).phase).toBe('ok')

    config = OIDC_CONFIG.replace('https://issuer.example', 'https://new-issuer.example')
    const state = await auth.syncContext()
    expect(state.phase).toBe('login_required')
    expect(state.tokenExpiresAt).toBeUndefined()
  })

  it('refreshes an expired token via the refresh grant and rewrites the cache', async () => {
    writeCachedToken(-60_000)
    const fresh = makeToken(60 * 60_000)
    const { fetchFn, grants } = fakeIssuer(() => json({ id_token: fresh }))
    const exec = vi.fn(() => ok())
    const auth = new AuthManager({ runner: fakeRunner(OIDC_CONFIG, exec), cacheDir, fetchFn })
    const s = await auth.probe()
    expect(s.phase).toBe('ok')
    expect(s.tokenExpiresAt).toBeGreaterThan(Date.now())
    expect(exec).not.toHaveBeenCalled() // no kubelogin, so no browser fallback
    expect(grants[0]?.get('grant_type')).toBe('refresh_token')
    expect(grants[0]?.get('refresh_token')).toBe('r')
    expect(grants[0]?.get('client_id')).toBe('abc')
    // kubelogin reads the same file: new id_token, refresh token kept
    expect(cached()).toEqual({ id_token: fresh, refresh_token: 'r' })
    expect(statSync(join(cacheDir, 'entry')).mode & 0o777).toBe(0o600)
  })

  it('keeps a rotated refresh token', async () => {
    writeCachedToken(-60_000)
    const { fetchFn } = fakeIssuer(() =>
      json({ id_token: makeToken(60 * 60_000), refresh_token: 'r2' }),
    )
    const auth = new AuthManager({ runner: fakeRunner(OIDC_CONFIG), cacheDir, fetchFn })
    expect((await auth.probe()).phase).toBe('ok')
    expect(cached().refresh_token).toBe('r2')
  })

  it('reads a rejected refresh grant as login_required', async () => {
    writeCachedToken(-60_000)
    const { fetchFn } = fakeIssuer()
    const auth = new AuthManager({ runner: fakeRunner(OIDC_CONFIG), cacheDir, fetchFn })
    const s = await auth.probe()
    expect(s.phase).toBe('login_required')
    expect(s.message).toMatch(/office network/)
  })

  it('needs a login when the cache holds no refresh token', async () => {
    const { fetchFn, grants } = fakeIssuer()
    const auth = new AuthManager({ runner: fakeRunner(OIDC_CONFIG), cacheDir, fetchFn })
    expect((await auth.probe()).phase).toBe('login_required')
    expect(grants).toHaveLength(0)
  })

  it.each([
    ['network failure', () => Promise.reject(new Error('fetch failed'))],
    ['server error', () => json({ error: 'internal' }, 500)],
  ])('reads a %s as a retryable error and recovers silently', async (_label, fail) => {
    writeCachedToken(-60_000)
    let failing = true
    const { fetchFn, grants } = fakeIssuer(() =>
      failing ? fail() : json({ id_token: makeToken(60 * 60_000) }),
    )
    const auth = new AuthManager({
      runner: fakeRunner(OIDC_CONFIG),
      cacheDir,
      fetchFn,
      expiryTtlMs: 0,
    })
    const s = await auth.probe()
    expect(s.phase).toBe('error')
    expect(s.message).toMatch(/retrying in 15s/)
    expect(cached().refresh_token).toBe('r')

    // within the backoff: maintenance and the kubectl gate leave it alone
    await auth.maintain()
    expect(auth.kubectlAllowed(['get', 'pods'])).toBe(false)
    await new Promise((r) => setTimeout(r, 10))
    expect(grants).toHaveLength(1)

    // backoff elapsed and the network is back: the next tick recovers
    failing = false
    vi.useFakeTimers({ now: Date.now() + 16_000, toFake: ['Date'] })
    try {
      expect((await auth.maintain()).phase).toBe('ok')
    } finally {
      vi.useRealTimers()
    }
    expect(grants).toHaveLength(2)
    expect(auth.kubectlAllowed(['get', 'pods'])).toBe(true)
  })

  it('backs off exponentially across repeated transport failures', async () => {
    writeCachedToken(-60_000)
    const { fetchFn } = fakeIssuer(() => Promise.reject(new Error('fetch failed')))
    const auth = new AuthManager({ runner: fakeRunner(OIDC_CONFIG), cacheDir, fetchFn })
    const start = Date.now()
    vi.useFakeTimers({ now: start, toFake: ['Date'] })
    try {
      expect((await auth.probe()).message).toMatch(/retrying in 15s/)
      vi.setSystemTime(start + 16_000)
      expect((await auth.probe()).message).toMatch(/retrying in 30s/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gates kubectl API calls while the token is stale, but never config/oidc-login', async () => {
    const auth = new AuthManager({
      runner: fakeRunner(OIDC_CONFIG),
      cacheDir,
      fetchFn: fakeIssuer().fetchFn,
      expiryTtlMs: 0,
    })
    await auth.init() // login_required
    expect(auth.kubectlAllowed(['get', 'pods', '-o', 'json'])).toBe(false)
    expect(auth.kubectlAllowed(['config', 'view'])).toBe(true)
    expect(auth.kubectlAllowed(['oidc-login', 'get-token'])).toBe(true)

    writeCachedToken(60 * 60_000)
    expect(auth.kubectlAllowed(['get', 'pods'])).toBe(true)
  })

  it('never starts a login from ensure after a probe fails', async () => {
    let logins = 0
    writeCachedToken(-60_000)
    const loginRunner = vi.fn(async () => {
      logins++
      return ok()
    })
    const auth = new AuthManager({
      runner: fakeRunner(OIDC_CONFIG),
      loginRunner,
      cacheDir,
      fetchFn: fakeIssuer().fetchFn,
    })
    const [a, b, c] = await Promise.all([auth.ensure(), auth.ensure(), auth.ensure()])
    expect([a.phase, b.phase, c.phase]).toEqual([
      'login_required',
      'login_required',
      'login_required',
    ])
    expect(logins).toBe(0)
  })

  it('coalesces explicit logins and always passes --skip-open-browser', async () => {
    const loginRunner = vi.fn(async (_cmd, args: string[]) => {
      expect(args).toContain('--skip-open-browser')
      await new Promise((resolve) => setTimeout(resolve, 20))
      writeCachedToken(60 * 60_000)
      return ok()
    })
    const auth = new AuthManager({
      runner: fakeRunner(OIDC_CONFIG),
      loginRunner,
      cacheDir,
      fetchFn: fakeIssuer().fetchFn,
    })
    await auth.init()
    const results = await Promise.all([auth.login(), auth.login(), auth.login()])
    expect(results.every((result) => result.phase === 'ok')).toBe(true)
    expect(loginRunner).toHaveBeenCalledTimes(1)
  })

  it('surfaces the login URL without opening it and retains a failure reason', async () => {
    let finishLogin: (() => void) | undefined
    const loginRunner = vi.fn(async (_cmd, _args, _opts, onLine) => {
      onLine('Please visit https://issuer.example/authorize?state=abc')
      await new Promise<void>((resolve) => {
        finishLogin = resolve
      })
      return { code: 1, stdout: '', stderr: 'callback timed out' }
    })
    const auth = new AuthManager({
      runner: fakeRunner(OIDC_CONFIG),
      loginRunner,
      cacheDir,
      fetchFn: fakeIssuer().fetchFn,
    })
    await auth.init()

    const login = auth.login()
    await vi.waitFor(() => expect(auth.snapshot().loginUrl).toContain('/authorize'))
    expect(auth.snapshot()).toMatchObject({
      oidc: true,
      phase: 'logging_in',
      message: 'open the sign-in URL to continue',
    })

    finishLogin?.()
    const result = await login
    expect(result.phase).toBe('login_required')
    expect(result.message).toContain('callback timed out')
  })

  it('does not hide an in-flight login when clearing the cache', async () => {
    let finishLogin: (() => void) | undefined
    const loginRunner = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finishLogin = resolve
      })
      return { code: -1, stdout: '', stderr: '' }
    })
    const auth = new AuthManager({
      runner: fakeRunner(OIDC_CONFIG),
      loginRunner,
      cacheDir,
      fetchFn: fakeIssuer().fetchFn,
    })
    await auth.init()

    const login = auth.login()
    expect(auth.clearCache()).toMatchObject({ oidc: true, phase: 'logging_in' })

    await vi.waitFor(() => expect(finishLogin).toBeTypeOf('function'))
    finishLogin?.()
    await login
  })

  it('clearCache removes the kubelogin cache dir and flips to login_required', async () => {
    writeCachedToken(60 * 60_000)
    const auth = new AuthManager({ runner: fakeRunner(OIDC_CONFIG), cacheDir })
    await auth.init()
    const s = auth.clearCache()
    expect(existsSync(cacheDir)).toBe(false)
    expect(s.phase).toBe('login_required')
    mkdirSync(cacheDir, { recursive: true }) // afterEach rm expects it
  })

  it('stops kicking probes from the kubectl gate once login is required', async () => {
    writeCachedToken(-60_000)
    const { fetchFn, grants } = fakeIssuer()
    const auth = new AuthManager({
      runner: fakeRunner(OIDC_CONFIG),
      cacheDir,
      fetchFn,
      expiryTtlMs: 0,
    })
    await auth.init() // one rejected grant → login_required
    expect(grants).toHaveLength(1)
    expect(auth.kubectlAllowed(['get', 'pods'])).toBe(false)
    await new Promise((r) => setTimeout(r, 10)) // a kicked probe would have fetched by now
    expect(grants).toHaveLength(1)
  })

  it('does not retry a failed explicit login', async () => {
    const bindError = {
      code: 1,
      stdout: '',
      stderr:
        'could not start a local server: listen tcp 127.0.0.1:8040: bind: address already in use',
    }
    const loginRunner = vi.fn(async () => bindError)
    const auth = new AuthManager({
      runner: fakeRunner(OIDC_CONFIG),
      loginRunner,
      cacheDir,
      fetchFn: fakeIssuer().fetchFn,
    })
    await auth.init()
    const s = await auth.login()
    expect(s.phase).toBe('login_required')
    expect(s.message).toContain('address already in use')
    expect(loginRunner).toHaveBeenCalledTimes(1)
  })

  it('maintain() refreshes a token that is merely near expiry', async () => {
    writeCachedToken(5 * 60_000) // valid, but < REFRESH_AHEAD_MS left
    const { fetchFn, grants } = fakeIssuer(() => json({ id_token: makeToken(60 * 60_000) }))
    const auth = new AuthManager({ runner: fakeRunner(OIDC_CONFIG), cacheDir, fetchFn })
    const s = await auth.maintain()
    expect(s.phase).toBe('ok')
    expect(grants).toHaveLength(1)
    // fresh-enough tokens are left alone
    await auth.maintain()
    expect(grants).toHaveLength(1)
  })
})
