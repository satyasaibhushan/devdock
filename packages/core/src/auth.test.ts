import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
    const exec = vi.fn(() => ({ code: -1, stdout: '', stderr: '' }))
    const auth = new AuthManager({ runner: fakeRunner(OIDC_CONFIG, exec), cacheDir })
    const state = await auth.init()
    expect(state.phase).toBe('login_required')
    expect(state.tokenExpiresAt).toBeUndefined()
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('rechecks the active context instead of trusting the previous context token', async () => {
    writeCachedToken(60 * 60_000)
    let config = OIDC_CONFIG
    const exec = vi.fn(() => ({ code: -1, stdout: '', stderr: '' }))
    const runner = vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
      if (cmd === 'kubectl' && args[0] === 'config') return ok(config)
      return exec()
    })
    const auth = new AuthManager({ runner, cacheDir })
    expect((await auth.init()).phase).toBe('ok')

    config = OIDC_CONFIG.replace('https://issuer.example', 'https://new-issuer.example')
    const state = await auth.syncContext()
    expect(state.phase).toBe('login_required')
    expect(state.tokenExpiresAt).toBeUndefined()
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('probes with --skip-open-browser and reads success as ok', async () => {
    const exec = vi.fn((_cmd: string, args: string[]) => {
      expect(args).toContain('--skip-open-browser')
      writeCachedToken(60 * 60_000) // kubelogin refreshed the cache
      return ok('{"kind":"ExecCredential"}')
    })
    const auth = new AuthManager({ runner: fakeRunner(OIDC_CONFIG, exec), cacheDir })
    const s = await auth.probe()
    expect(s.phase).toBe('ok')
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('reads a killed (hanging) probe as login_required', async () => {
    // timeoutMs kill → run() resolves code -1: kubelogin was waiting for a
    // browser callback, i.e. the refresh token is gone and login is needed.
    const exec = vi.fn(() => ({ code: -1, stdout: '', stderr: '' }))
    const auth = new AuthManager({ runner: fakeRunner(OIDC_CONFIG, exec), cacheDir })
    const s = await auth.probe()
    expect(s.phase).toBe('login_required')
    expect(s.message).toMatch(/office network/)
  })

  it('reads an interactive-flow banner as login_required even on quick exit', async () => {
    const exec = vi.fn(() => ({
      code: 1,
      stdout: '',
      stderr: 'Please visit the following URL in your browser: https://issuer.example/authorize',
    }))
    const auth = new AuthManager({ runner: fakeRunner(OIDC_CONFIG, exec), cacheDir })
    const s = await auth.probe()
    expect(s.phase).toBe('login_required')
  })

  it('reads other kubelogin failures as error, not login_required', async () => {
    const exec = vi.fn(() => ({ code: 1, stdout: '', stderr: 'dial tcp: no route to host' }))
    const auth = new AuthManager({ runner: fakeRunner(OIDC_CONFIG, exec), cacheDir })
    const s = await auth.probe()
    expect(s.phase).toBe('error')
    expect(s.message).toContain('no route to host')
  })

  it('gates kubectl API calls while the token is stale, but never config/oidc-login', async () => {
    const exec = vi.fn(() => ({ code: -1, stdout: '', stderr: '' }))
    const auth = new AuthManager({
      runner: fakeRunner(OIDC_CONFIG, exec),
      cacheDir,
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
    const probe = vi.fn(() => ({ code: -1, stdout: '', stderr: '' }))
    const loginRunner = vi.fn(async () => {
      logins++
      return ok()
    })
    const auth = new AuthManager({
      runner: fakeRunner(OIDC_CONFIG, probe),
      loginRunner,
      cacheDir,
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
      runner: fakeRunner(OIDC_CONFIG, () => ({ code: -1, stdout: '', stderr: '' })),
      loginRunner,
      cacheDir,
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
      runner: fakeRunner(OIDC_CONFIG, () => ({ code: -1, stdout: '', stderr: '' })),
      loginRunner,
      cacheDir,
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
      runner: fakeRunner(OIDC_CONFIG, () => ({ code: -1, stdout: '', stderr: '' })),
      loginRunner,
      cacheDir,
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
    const exec = vi.fn(() => ({ code: -1, stdout: '', stderr: '' }))
    const auth = new AuthManager({
      runner: fakeRunner(OIDC_CONFIG, exec),
      cacheDir,
      expiryTtlMs: 0,
    })
    await auth.init() // one probe → login_required
    expect(exec).toHaveBeenCalledTimes(1)
    expect(auth.kubectlAllowed(['get', 'pods'])).toBe(false)
    await new Promise((r) => setTimeout(r, 10)) // a kicked probe would have spawned by now
    expect(exec).toHaveBeenCalledTimes(1) // no new kubelogin holding the callback port
  })

  it('reads a callback-port conflict as login_required, not error', async () => {
    const exec = vi.fn(() => ({
      code: 1,
      stdout: '',
      stderr:
        'error: could not start a local server: listen tcp 127.0.0.1:8040: bind: address already in use',
    }))
    const auth = new AuthManager({ runner: fakeRunner(OIDC_CONFIG, exec), cacheDir })
    const s = await auth.probe()
    expect(s.phase).toBe('login_required')
    expect(s.message).toContain('another sign-in')
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
      runner: fakeRunner(OIDC_CONFIG, () => ({ code: -1, stdout: '', stderr: '' })),
      loginRunner,
      cacheDir,
    })
    await auth.init()
    const s = await auth.login()
    expect(s.phase).toBe('login_required')
    expect(s.message).toContain('address already in use')
    expect(loginRunner).toHaveBeenCalledTimes(1)
  })

  it('maintain() force-refreshes a token that is merely near expiry', async () => {
    writeCachedToken(5 * 60_000) // valid, but < REFRESH_AHEAD_MS left
    const exec = vi.fn((_cmd: string, args: string[]) => {
      expect(args).toContain('--force-refresh')
      writeCachedToken(60 * 60_000)
      return ok()
    })
    const auth = new AuthManager({ runner: fakeRunner(OIDC_CONFIG, exec), cacheDir })
    const s = await auth.maintain()
    expect(s.phase).toBe('ok')
    expect(exec).toHaveBeenCalledTimes(1)
    // fresh-enough tokens are left alone
    exec.mockClear()
    await auth.maintain()
    expect(exec).not.toHaveBeenCalled()
  })
})
