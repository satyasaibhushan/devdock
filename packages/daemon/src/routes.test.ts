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

  it('GET /repos/:id/logs 404 for unknown', async () => {
    const { svc } = makeService()
    const app = buildApp(svc)
    const res = await app.inject({ method: 'GET', url: '/repos/nope/logs' })
    expect(res.statusCode).toBe(404)
  })
})
