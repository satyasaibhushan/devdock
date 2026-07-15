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
function makeToken(expiresInMs: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor((Date.now() + expiresInMs) / 1000) }),
  ).toString('base64url')
  return `h.${payload}.s`
}

let cacheDir: string
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'devdock-auth-'))
})
afterEach(() => rmSync(cacheDir, { recursive: true, force: true }))

function writeCachedToken(expiresInMs: number): void {
  writeFileSync(
    join(cacheDir, 'entry'),
    JSON.stringify({ id_token: makeToken(expiresInMs), refresh_token: 'r' }),
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

  it('treats unreadable kubeconfig output as no oidc (fakes, broken kubectl)', async () => {
    const auth = new AuthManager({ runner: fakeRunner(''), cacheDir })
    const s = await auth.ensure()
    expect(s.phase).toBe('ok')
    expect(s.oidc).toBe(false)
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

  it('coalesces concurrent ensure() calls into one interactive login', async () => {
    let logins = 0
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes('--skip-open-browser')) return { code: -1, stdout: '', stderr: '' }
      logins++
      await new Promise((r) => setTimeout(r, 20)) // the user signs in…
      writeCachedToken(60 * 60_000)
      return ok('{"kind":"ExecCredential"}')
    })
    const auth = new AuthManager({ runner: fakeRunner(OIDC_CONFIG, exec), cacheDir })
    const [a, b, c] = await Promise.all([auth.ensure(), auth.ensure(), auth.ensure()])
    expect(a?.phase).toBe('ok')
    expect(b?.phase).toBe('ok')
    expect(c?.phase).toBe('ok')
    expect(logins).toBe(1)
  })

  it('does not auto-reopen the browser during the failure cooldown', async () => {
    let logins = 0
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes('--skip-open-browser')) return { code: -1, stdout: '', stderr: '' }
      logins++
      return { code: -1, stdout: '', stderr: '' } // timed out — user is at home
    })
    const auth = new AuthManager({
      runner: fakeRunner(OIDC_CONFIG, exec),
      cacheDir,
      loginCooldownMs: 60_000,
    })
    const first = await auth.ensure()
    expect(first.phase).toBe('login_required')
    expect(logins).toBe(1)
    const second = await auth.ensure() // within cooldown → no new browser tab
    expect(second.phase).toBe('login_required')
    expect(logins).toBe(1)
    // …but an explicit login (the UI button) always may retry.
    await auth.login()
    expect(logins).toBe(2)
  })

  it('reports an interactive login immediately and retains its failure reason', async () => {
    const exec = vi.fn((_cmd: string, args: string[]) => {
      if (args.includes('--skip-open-browser')) return { code: -1, stdout: '', stderr: '' }
      return { code: 1, stdout: '', stderr: 'could not open the default browser' }
    })
    const auth = new AuthManager({ runner: fakeRunner(OIDC_CONFIG, exec), cacheDir })
    await auth.init()

    const login = auth.login()
    expect(auth.snapshot()).toMatchObject({ oidc: true, phase: 'logging_in' })

    const result = await login
    expect(result.phase).toBe('login_required')
    expect(result.message).toContain('could not open the default browser')
  })

  it('does not hide an in-flight login when clearing the cache', async () => {
    let finishLogin: (() => void) | undefined
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes('--skip-open-browser')) return { code: -1, stdout: '', stderr: '' }
      await new Promise<void>((resolve) => {
        finishLogin = resolve
      })
      return { code: -1, stdout: '', stderr: '' }
    })
    const auth = new AuthManager({ runner: fakeRunner(OIDC_CONFIG, exec), cacheDir })
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
