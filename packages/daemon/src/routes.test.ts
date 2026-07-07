import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RunResult, Service } from '@devdock/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './routes.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devdock-routes-'))
  mkdirSync(join(root, 'svc-a'), { recursive: true })
  writeFileSync(join(root, 'svc-a', 'devspace.yaml'), 'name: svc-a\nnamespace: ns\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function makeService(start = vi.fn()) {
  const runner = vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
    if (cmd === 'tmux' && args[0] === 'has-session') return { code: 1, stdout: '', stderr: '' }
    if (cmd === 'tmux' && args[0] === 'new-session') {
      start()
      return { code: 0, stdout: '', stderr: '' }
    }
    if (cmd === 'kubectl' && args[0] === 'config') {
      // `config view` reads the context namespace; `set-context` switches it
      return { code: 0, stdout: args[1] === 'view' ? 'testns' : '', stderr: '' }
    }
    if (cmd === 'kubectl') return { code: 0, stdout: '{"items":[]}', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  })
  const svc = new Service({ roots: [root], stateFile: join(root, 'state.json') }, { runner })
  svc.rescan()
  return { svc, start }
}

describe('daemon routes', () => {
  it('GET /health', async () => {
    const { svc } = makeService()
    const app = buildApp(svc)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.json()).toEqual({ ok: true })
  })

  it('GET /repos/:id 404 for unknown', async () => {
    const { svc } = makeService()
    const app = buildApp(svc)
    const res = await app.inject({ method: 'GET', url: '/repos/nope' })
    expect(res.statusCode).toBe(404)
  })

  it('reconciles then serves /repos and /repos/:id', async () => {
    const { svc } = makeService()
    await svc.reconcileAll()
    const app = buildApp(svc)
    expect((await app.inject({ method: 'GET', url: '/repos' })).json()).toHaveLength(1)
    const one = await app.inject({ method: 'GET', url: '/repos/svc-a' })
    expect(one.json().status).toBe('STOPPED')
  })

  it('POST /repos/:id/start invokes the supervisor', async () => {
    const { svc, start } = makeService()
    await svc.reconcileAll()
    const app = buildApp(svc)
    const res = await app.inject({ method: 'POST', url: '/repos/svc-a/start' })
    expect(res.json()).toMatchObject({ ok: true })
    expect(start).toHaveBeenCalled()
  })

  it('POST /repos/:id/exec 400 without a command', async () => {
    const { svc } = makeService()
    await svc.reconcileAll()
    const app = buildApp(svc)
    const res = await app.inject({ method: 'POST', url: '/repos/svc-a/exec', payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('POST /repos/:id/exec sends the command', async () => {
    const { svc } = makeService()
    await svc.reconcileAll()
    const app = buildApp(svc)
    const res = await app.inject({
      method: 'POST',
      url: '/repos/svc-a/exec',
      payload: { command: 'pnpm test' },
    })
    expect(res.json()).toMatchObject({ ok: true })
  })

  it('GET /namespace reports the context namespace and the known list', async () => {
    const { svc } = makeService()
    const app = buildApp(svc)
    const res = await app.inject({ method: 'GET', url: '/namespace' })
    const body = res.json()
    expect(body.current).toBe('testns')
    // svc-a's config declares `namespace: ns`; the context one is learned too
    expect(body.known).toEqual(expect.arrayContaining(['ns', 'testns']))
  })

  it('PUT /namespace switches the kube context', async () => {
    const { svc } = makeService()
    const app = buildApp(svc)
    const res = await app.inject({
      method: 'PUT',
      url: '/namespace',
      payload: { namespace: 'panels' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().known).toContain('panels')
  })

  it('PUT /namespace rejects a missing or invalid name', async () => {
    const { svc } = makeService()
    const app = buildApp(svc)
    expect((await app.inject({ method: 'PUT', url: '/namespace', payload: {} })).statusCode).toBe(
      400,
    )
    const bad = await app.inject({
      method: 'PUT',
      url: '/namespace',
      payload: { namespace: 'Not A Namespace!' },
    })
    expect(bad.statusCode).toBe(400)
  })

  it('GET /repos/:id/logs 404 for unknown', async () => {
    const { svc } = makeService()
    const app = buildApp(svc)
    const res = await app.inject({ method: 'GET', url: '/repos/nope/logs' })
    expect(res.statusCode).toBe(404)
  })

  it('terminal lifecycle: open local, list, run, read output, close', async () => {
    let dataCb: (d: string) => void = () => {}
    const session = {
      mode: 'rw' as const,
      onData: (cb: (d: string) => void) => {
        dataCb = cb
      },
      onExit: () => {},
      write: (d: string) => dataCb(`${d}\nran it\n`), // echo back like a shell
      resize: () => {},
      close: vi.fn(),
    }
    const broker = { openLocal: vi.fn(async () => session) }
    const svc = new Service(
      { roots: [root], stateFile: join(root, 'state.json') },
      { runner: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })), broker: broker as never },
    )
    const app = buildApp(svc)

    const opened = await app.inject({ method: 'POST', url: '/terminals', payload: {} })
    expect(opened.statusCode).toBe(200)
    const tid = opened.json().id
    expect(tid).toBe('t1')
    expect(opened.json()).toMatchObject({ kind: 'local', alive: true })

    const list = await app.inject({ method: 'GET', url: '/terminals' })
    expect(list.json()).toHaveLength(1)

    const run = await app.inject({
      method: 'POST',
      url: `/terminals/${tid}/run`,
      payload: { command: 'do thing' },
    })
    expect(run.statusCode).toBe(200)
    expect(run.json().output).toContain('ran it')
    expect(run.json().timedOut).toBe(false)

    const out = await app.inject({ method: 'GET', url: `/terminals/${tid}/output?tail=5` })
    expect(out.json().output).toContain('ran it')

    const closed = await app.inject({ method: 'DELETE', url: `/terminals/${tid}` })
    expect(closed.json()).toEqual({ ok: true })
    expect(session.close).toHaveBeenCalled()
    expect((await app.inject({ method: 'GET', url: '/terminals' })).json()).toEqual([])
  }, 15_000)

  it('terminal routes validate input and unknown ids', async () => {
    const { svc } = makeService()
    const app = buildApp(svc)
    const badKind = await app.inject({
      method: 'POST',
      url: '/terminals',
      payload: { kind: 'nope' },
    })
    expect(badKind.statusCode).toBe(400)
    const noRepo = await app.inject({
      method: 'POST',
      url: '/terminals',
      payload: { kind: 'shell' },
    })
    expect(noRepo.statusCode).toBe(400)
    const noCmd = await app.inject({ method: 'POST', url: '/terminals/t9/run', payload: {} })
    expect(noCmd.statusCode).toBe(400)
    const unknownRun = await app.inject({
      method: 'POST',
      url: '/terminals/t9/run',
      payload: { command: 'ls' },
    })
    expect(unknownRun.statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/terminals/t9/output' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: '/terminals/t9' })).statusCode).toBe(404)
  })

  it('GET /auth reports the auth snapshot (no-oidc test cluster → ok)', async () => {
    const { svc } = makeService()
    await svc.startLoop() // the daemon probes auth at boot; before that the phase is 'unknown'
    svc.stopLoop()
    const app = buildApp(svc)
    const res = await app.inject({ method: 'GET', url: '/auth' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ oidc: false, phase: 'ok' })
  })

  it('POST /auth/login and /auth/clear return snapshots', async () => {
    const auth = {
      snapshot: vi.fn(() => ({ oidc: true, phase: 'logging_in', checkedAt: 1 })),
      login: vi.fn(async () => ({ oidc: true, phase: 'ok', checkedAt: 2 })),
      clearCache: vi.fn(() => ({ oidc: true, phase: 'login_required', checkedAt: 3 })),
    }
    const svc = new Service(
      { roots: [root], stateFile: join(root, 'state.json') },
      { runner: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })), auth: auth as never },
    )
    const app = buildApp(svc)
    const login = await app.inject({ method: 'POST', url: '/auth/login' })
    expect(login.json().phase).toBe('logging_in') // immediate snapshot, flow continues behind
    expect(auth.login).toHaveBeenCalled()
    const clear = await app.inject({ method: 'POST', url: '/auth/clear' })
    expect(clear.json().phase).toBe('login_required')
    expect(auth.clearCache).toHaveBeenCalled()
  })
})
