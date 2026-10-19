import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RunResult, Service } from '@devdock/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessGate } from './accessGate.js'
import { buildAgentApp } from './agentAccess.js'
import { Instances } from './instances.js'
import { buildApp } from './routes.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devdock-routes-'))
  mkdirSync(join(root, 'svc-a'), { recursive: true })
  writeFileSync(join(root, 'svc-a', 'devspace.yaml'), 'name: svc-a\nnamespace: ns\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function makeService(start = vi.fn(), instanceId?: string) {
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
    if (cmd === 'kubectl' && args.includes('configmap'))
      return {
        code: 0,
        stdout: JSON.stringify({ data: { instance: 'other-machine', deployment: 'svc-a' } }),
        stderr: '',
      }
    if (cmd === 'kubectl') return { code: 0, stdout: '{"items":[]}', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  })
  const svc = new Service(
    { roots: [root], stateFile: join(root, 'state.json'), instanceId },
    { runner },
  )
  svc.rescan()
  return { svc, start }
}

it('development socket allows repository operations but denies host shells and peer access', async () => {
  const { svc } = makeService()
  const app = buildAgentApp(svc)
  try {
    expect((await app.inject({ method: 'GET', url: '/repos' })).statusCode).toBe(200)
    const exec = vi
      .spyOn(svc, 'exec')
      .mockResolvedValue({ code: 0, stdout: 'verified', stderr: '' })
    const result = await app.inject({
      method: 'POST',
      url: '/repos/svc-a/exec',
      payload: { command: 'echo verified' },
    })
    expect(result.statusCode).toBe(200)
    expect(exec).toHaveBeenCalled()
    for (const url of [
      '/terminals',
      '/terminals/host:1/run',
      '/instances',
      '/instances/mac/api/terminals',
      '/aws/credential',
    ]) {
      expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(403)
    }
  } finally {
    await app.close()
  }
})

describe('daemon routes', () => {
  it('returns an operation receipt without waiting for deployment and exposes the same ID on reads', async () => {
    const { svc } = makeService()
    let finish!: (result: RunResult) => void
    vi.spyOn(svc, 'lifecycle').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const app = buildApp(svc)
    const response = await app.inject({
      method: 'POST',
      url: '/repos/svc-a/operations',
      payload: { action: 'build' },
    })
    expect(response.statusCode).toBe(202)
    const receipt = response.json()
    expect((await app.inject(`/operations/${receipt.id}`)).json().id).toBe(receipt.id)
    const duplicate = await app.inject({
      method: 'POST',
      url: '/repos/svc-a/operations',
      payload: { action: 'build' },
    })
    expect(duplicate.json().id).toBe(receipt.id)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    finish({ code: 0, stdout: '', stderr: '' })
    await vi.waitFor(() => expect(svc.getOperation(receipt.id).state).toBe('succeeded'))
    expect((await app.inject('/operations?repo=svc-a')).json()).toHaveLength(1)
    await app.close()
  })
  it('routes stop-session separately from destructive stop', async () => {
    const { svc } = makeService()
    const stopSession = vi
      .spyOn(svc, 'stopSession')
      .mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    const stop = vi.spyOn(svc, 'stop')
    const app = buildApp(svc)
    const result = await app.inject({
      method: 'POST',
      url: '/repos/svc-a/stop-session?workload=api',
    })
    expect(result.statusCode).toBe(200)
    expect(stopSession).toHaveBeenCalledWith('svc-a', 'api')
    expect(stop).not.toHaveBeenCalled()
    await app.close()
  })
  it('rejects lifecycle work owned by another instance before starting a process', async () => {
    const { svc, start } = makeService(vi.fn(), 'this-machine')
    for (const action of ['start', 'build', 'stop', 'clear', 'adopt'] as const) {
      await expect(svc[action]('svc-a')).rejects.toThrow('owned by instance other-machine')
    }
    expect(start).not.toHaveBeenCalled()
  })
  it('routes an explicit local instance and denies credential forwarding', async () => {
    const { svc } = makeService()
    const instances = new Instances(join(root, 'identity'))
    const app = buildApp(svc, new AccessGate('secret'), instances)
    const result = await app.inject({
      method: 'GET',
      url: `/instances/${instances.identity.id}/api/namespace`,
    })
    expect(result.statusCode).toBe(200)
    expect(result.json().current).toBe('testns')
    const denied = await app.inject({
      method: 'GET',
      url: `/instances/${instances.identity.id}/api/aws/credential`,
    })
    expect(denied.statusCode).toBe(403)
    await app.close()
  })
  it.each([
    [
      '  SSH connection failed; check the host alias and socket\n',
      'SSH connection failed; check the host alias and socket',
    ],
    ['Peer identity changed; relink explicitly', 'Peer identity changed; relink explicitly'],
    ['request failed token=private-value https://user:password@peer', 'Peer unavailable'],
  ])('reports a safe offline peer reason for %s', async (message, expected) => {
    const { svc } = makeService()
    const instances = new Instances(join(root, 'identity'))
    vi.spyOn(instances, 'list').mockReturnValue([
      {
        id: 'peer',
        name: 'box',
        protocol: 1,
        host: 'box',
        endpoint: '127.0.0.1:8000',
        terminals: false,
      },
    ])
    vi.spyOn(instances, 'request').mockRejectedValue(new Error(message))
    const app = buildApp(svc, undefined, instances)
    try {
      const response = await app.inject('/instances')
      expect(response.statusCode).toBe(200)
      expect(response.json()[1]).toMatchObject({
        id: 'peer',
        online: false,
        error: expected,
        repos: [],
      })
      expect(response.json()[0]).not.toHaveProperty('error')
    } finally {
      await app.close()
    }
  })

  it('GET /health', async () => {
    const { svc } = makeService()
    const app = buildApp(svc)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.json()).toEqual({ ok: true, state: { ok: true }, warnings: [] })
  })

  it('reports ignored duplicate configs through /health without failing health checks', async () => {
    const { svc } = makeService()
    const ignored = join(root, 'templates', 'svc-a')
    mkdirSync(ignored, { recursive: true })
    writeFileSync(join(ignored, 'devspace.yaml'), 'name: template\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const app = buildApp(svc)
    try {
      svc.rescan()
      const res = await app.inject({ method: 'GET', url: '/health' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        ok: true,
        state: { ok: true },
        warnings: [
          `duplicate repo id "svc-a": keeping ${join(root, 'svc-a')}; ${ignored} is ignored`,
        ],
      })
    } finally {
      warn.mockRestore()
      await app.close()
    }
  })

  it('applies ingress authority before routes run', async () => {
    const { svc } = makeService()
    const app = buildApp(svc, new AccessGate('secret'))
    const blocked = await app.inject({
      method: 'GET',
      url: '/repos',
      headers: { host: '127.0.0.1:7717', origin: 'https://evil.example' },
    })
    expect(blocked.statusCode).toBe(403)
    const authorized = await app.inject({
      method: 'GET',
      url: '/repos',
      headers: { authorization: 'Bearer secret' },
    })
    expect(authorized.statusCode).toBe(200)
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

  it('rejects Start from STOPPED and offers Build + Start instead', async () => {
    const { svc, start } = makeService()
    await svc.reconcileAll()
    const app = buildApp(svc)
    const invalid = await app.inject({ method: 'POST', url: '/repos/svc-a/start' })
    expect(invalid.statusCode).toBe(409)
    expect(invalid.json().stderr).toContain('not available')
    expect(start).not.toHaveBeenCalled()

    const res = await app.inject({ method: 'POST', url: '/repos/svc-a/build-start' })
    expect(res.statusCode).toBe(200)
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

  it('PUT /repos/:id/startup saves commands by pod type', async () => {
    const { svc } = makeService()
    await svc.reconcileAll()
    const app = buildApp(svc)
    const saved = await app.inject({
      method: 'PUT',
      url: '/repos/svc-a/startup',
      payload: { workload: 'api', command: 'pnpm api' },
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({
      startupCommand: 'pnpm api',
      startupCommands: { api: 'pnpm api' },
    })
    expect(svc.get('svc-a')?.startupCommands).toEqual({ api: 'pnpm api' })
  })

  it('PUT /repos/:id/startup validates the command', async () => {
    const { svc } = makeService()
    const app = buildApp(svc)
    const res = await app.inject({
      method: 'PUT',
      url: '/repos/svc-a/startup',
      payload: { workload: 'api' },
    })
    expect(res.statusCode).toBe(400)
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
    expect(tid).toBe('host:t1')
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

  it('GET /aws/credential serves the minted credential_process payload', async () => {
    const cred = {
      Version: 1,
      AccessKeyId: 'AKIA',
      SecretAccessKey: 's',
      SessionToken: 't',
      Expiration: new Date(Date.now() + 3600_000).toISOString(),
    }
    const awsCreds = {
      credential: vi.fn(async () => ({ ok: true, cred })),
    }
    const svc = new Service(
      { roots: [root], stateFile: join(root, 'state.json') },
      {
        runner: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
        awsCreds: awsCreds as never,
      },
    )
    const app = buildApp(svc)
    const res = await app.inject({ method: 'GET', url: '/aws/credential' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(cred)
  })

  it('GET /aws/credential maps a failed mint to 503 + the reason', async () => {
    const awsCreds = {
      credential: vi.fn(async () => ({ ok: false, message: 'sign-in did not complete' })),
    }
    const svc = new Service(
      { roots: [root], stateFile: join(root, 'state.json') },
      {
        runner: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
        awsCreds: awsCreds as never,
      },
    )
    const app = buildApp(svc)
    const res = await app.inject({ method: 'GET', url: '/aws/credential' })
    expect(res.statusCode).toBe(503)
    expect(res.json().error).toContain('sign-in')
  })

  // ---- agent-loop endpoints: /run, /logs/query, /wait ----

  function makeRunService() {
    const podsJson = JSON.stringify({
      items: [
        {
          metadata: { name: 'svc-a-app-devspace-1' },
          status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] },
        },
      ],
    })
    const runner = vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
      if (cmd === 'kubectl' && args[0] === 'exec') {
        return { code: 3, stdout: 'ran it', stderr: 'boom' }
      }
      if (cmd === 'tmux' && args[0] === 'list-panes')
        return { code: 0, stdout: 'devdock-svc-a 0\n', stderr: '' }
      if (cmd === 'kubectl' && args[0] === 'get') {
        return {
          code: 0,
          stdout: args[1] === 'deployments' ? '{"items":[]}' : podsJson,
          stderr: '',
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const svc = new Service({ roots: [root], stateFile: join(root, 'state.json') }, { runner })
    svc.rescan()
    return svc
  }

  it('POST /repos/:id/run returns the real exit code and output', async () => {
    const svc = makeRunService()
    await svc.reconcileAll()
    const app = buildApp(svc)
    const res = await app.inject({
      method: 'POST',
      url: '/repos/svc-a/run',
      payload: { command: 'pytest -q' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      ok: false,
      exitCode: 3,
      stdout: 'ran it',
      stderr: 'boom',
      pod: 'svc-a-app-devspace-1',
    })
  })

  it('POST /repos/:id/run 400 without a command, 404 for unknown repo', async () => {
    const svc = makeRunService()
    await svc.reconcileAll()
    const app = buildApp(svc)
    const noCmd = await app.inject({ method: 'POST', url: '/repos/svc-a/run', payload: {} })
    expect(noCmd.statusCode).toBe(400)
    const noRepo = await app.inject({
      method: 'POST',
      url: '/repos/nope/run',
      payload: { command: 'true' },
    })
    expect(noRepo.statusCode).toBe(404)
  })

  it('GET /repos/:id/logs/query reads the application pipe file with a cursor', async () => {
    const svc = makeRunService()
    await svc.reconcileAll()
    mkdirSync(join(root, 'logs'), { recursive: true })
    writeFileSync(join(root, 'logs', 'svc-a.dev.log'), 'boot ok\n')
    const app = buildApp(svc)
    const first = await app.inject({
      method: 'GET',
      url: '/repos/svc-a/logs/query?source=application',
    })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ source: 'application', lines: ['boot ok'] })

    writeFileSync(join(root, 'logs', 'svc-a.dev.log'), 'boot ok\nready\n')
    const second = await app.inject({
      method: 'GET',
      url: `/repos/svc-a/logs/query?source=application&cursor=${encodeURIComponent(first.json().cursor)}`,
    })
    expect(second.json().lines).toEqual(['ready'])
  })

  it('GET /repos/:id/logs/query 400 on a bad source', async () => {
    const svc = makeRunService()
    await svc.reconcileAll()
    const app = buildApp(svc)
    const res = await app.inject({ method: 'GET', url: '/repos/svc-a/logs/query?source=nope' })
    expect(res.statusCode).toBe(400)
  })

  // ---- replica endpoints ----

  function makeReplicaService() {
    for (const type of ['api', 'worker']) {
      const dir = join(root, 'parent', '.devspace', `parent-${type}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'devspace.yaml'),
        [
          `name: parent-${type}`,
          'namespace: ns',
          'vars:',
          `  WORKLOAD_TYPE: ${type}`,
          '  INGRESS_PATH: parent',
        ].join('\n'),
      )
    }
    const runner = vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
      if (cmd === 'git' && args.includes('for-each-ref'))
        return { code: 0, stdout: 'main\t1700000000\nfeature-x\t1690000000\n', stderr: '' }
      if (cmd === 'tmux' && args[0] === 'has-session') return { code: 1, stdout: '', stderr: '' }
      if (cmd === 'kubectl') return { code: 0, stdout: '{"items":[]}', stderr: '' }
      // The isolation check reads the resolved config; these have no dev targets.
      if (args[1]?.includes('devspace print'))
        return { code: 0, stdout: 'version: v2beta1\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const svc = new Service({ roots: [root], stateFile: join(root, 'state.json') }, { runner })
    svc.rescan()
    return svc
  }

  it('GET /repos/:id/branches lists local branches, 404 for unknown repo', async () => {
    const app = buildApp(makeReplicaService())
    const res = await app.inject({ method: 'GET', url: '/repos/parent/branches' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      { name: 'main', lastCommitAt: 1_700_000_000_000 },
      { name: 'feature-x', lastCommitAt: 1_690_000_000_000 },
    ])
    expect((await app.inject({ method: 'GET', url: '/repos/nope/branches' })).statusCode).toBe(404)
  })

  it('replica lifecycle over HTTP: create 201, list, delete, gc', async () => {
    const app = buildApp(makeReplicaService())
    const created = await app.inject({
      method: 'POST',
      url: '/repos/parent/replicas',
      payload: { branch: 'feature-x' },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({
      id: 'parent-r1',
      parentId: 'parent',
      branch: 'feature-x',
    })

    const list = await app.inject({ method: 'GET', url: '/replicas' })
    expect(list.json().map((r: { id: string }) => r.id)).toEqual(['parent-r1'])

    const gone = await app.inject({ method: 'DELETE', url: '/replicas/parent-r1' })
    expect(gone.json()).toEqual({ ok: true })
    expect((await app.inject({ method: 'GET', url: '/replicas' })).json()).toEqual([])
    expect((await app.inject({ method: 'DELETE', url: '/replicas/parent-r1' })).statusCode).toBe(
      404,
    )

    const gc = await app.inject({ method: 'POST', url: '/replicas/gc' })
    expect(gc.json()).toEqual({ deleted: [] })
  })

  it('POST /repos/:id/replicas validates branch and repo, accepts single-config repos', async () => {
    const app = buildApp(makeReplicaService())
    const noBranch = await app.inject({
      method: 'POST',
      url: '/repos/parent/replicas',
      payload: {},
    })
    expect(noBranch.statusCode).toBe(400)
    const singleConfig = await app.inject({
      method: 'POST',
      url: '/repos/svc-a/replicas',
      payload: { branch: 'main', ownImage: true },
    })
    expect(singleConfig.statusCode).toBe(201)
    expect(singleConfig.json()).toMatchObject({ id: 'svc-a-r1', ownImage: true })
    const unknown = await app.inject({
      method: 'POST',
      url: '/repos/nope/replicas',
      payload: { branch: 'main' },
    })
    expect(unknown.statusCode).toBe(404)
  })

  it('POST /repos/:id/wait resolves on status and 400s with no condition', async () => {
    const svc = makeRunService()
    await svc.reconcileAll()
    const app = buildApp(svc)
    const ok = await app.inject({
      method: 'POST',
      url: '/repos/svc-a/wait',
      payload: { status: 'RUNNING_MANAGED', timeoutMs: 1000 },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ matched: true, reason: 'status', status: 'RUNNING_MANAGED' })

    const bad = await app.inject({ method: 'POST', url: '/repos/svc-a/wait', payload: {} })
    expect(bad.statusCode).toBe(400)
  })
})

it('serves sandbox reads on the development socket and validates actors on every write', async () => {
  const { svc } = makeService()
  const app = buildAgentApp(svc)
  vi.spyOn(svc, 'listSandboxes').mockResolvedValue([])
  vi.spyOn(svc, 'sandboxStatus').mockRejectedValue(new Error('unknown sandbox: missing'))
  try {
    expect((await app.inject({ method: 'GET', url: '/sandboxes' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/sandboxes/controller' })).json()).toEqual({
      holder: null,
      isLeader: false,
      lastPollAt: null,
      lastError: null,
    })
    expect((await app.inject({ method: 'GET', url: '/sandboxes/missing' })).statusCode).toBe(404)
    const writes = [
      { method: 'POST' as const, url: '/sandboxes' },
      { method: 'PATCH' as const, url: '/sandboxes/SULF-1' },
      { method: 'DELETE' as const, url: '/sandboxes/SULF-1' },
      ...['build', 'snapshot', 'wake', 'sleep', 'expire'].map((a) => ({
        method: 'POST' as const,
        url: `/sandboxes/SULF-1/${a}`,
      })),
    ]
    for (const route of writes) {
      for (const payload of [{}, { actor: ' ' }, { actor: 42 }]) {
        const response = await app.inject({ ...route, payload })
        expect(response.statusCode).toBe(400)
        expect(response.json()).toEqual({ error: 'actor required' })
      }
    }
  } finally {
    await app.close()
  }
})

it('routes sandbox mutations to the core and forwards log/exec targets', async () => {
  const { svc } = makeService()
  const app = buildApp(svc)
  const receipt = { operationId: 'op1' }
  const create = vi.spyOn(svc, 'createSandbox').mockResolvedValue(receipt)
  const update = vi.spyOn(svc, 'updateSandbox').mockReturnValue(receipt)
  const build = vi.spyOn(svc, 'buildSandbox').mockReturnValue(receipt)
  const query = vi
    .spyOn(svc, 'queryLogs')
    .mockResolvedValue({ source: 'container', lines: [], cursor: '' })
  const run = vi.spyOn(svc, 'runInWorkload').mockResolvedValue({
    ok: true,
    exitCode: 0,
    stdout: 'slot',
    stderr: '',
    timedOut: false,
    truncated: false,
  })
  try {
    const body = { key: 'SULF-1', actor: 'you' }
    expect((await app.inject({ method: 'POST', url: '/sandboxes', payload: body })).json()).toEqual(
      receipt,
    )
    expect(create).toHaveBeenCalledWith(body)
    await app.inject({
      method: 'PATCH',
      url: '/sandboxes/SULF-1',
      payload: { actor: 'you', remove: [] },
    })
    expect(update).toHaveBeenCalledWith('SULF-1', { actor: 'you', remove: [] })
    await app.inject({
      method: 'POST',
      url: '/sandboxes/SULF-1/build',
      payload: { actor: 'you', repo: 'svc-a' },
    })
    expect(build).toHaveBeenCalledWith('SULF-1', { actor: 'you', repo: 'svc-a' })
    for (const action of ['wake', 'sleep', 'expire', 'delete'] as const) {
      const method = vi.spyOn(svc, `${action}Sandbox`).mockReturnValue(receipt)
      const response = await app.inject({
        method: action === 'delete' ? 'DELETE' : 'POST',
        url: action === 'delete' ? '/sandboxes/SULF-1' : `/sandboxes/SULF-1/${action}`,
        payload: { actor: 'you' },
      })
      expect(response.json()).toEqual(receipt)
      if (action === 'wake')
        expect(method).toHaveBeenCalledWith('SULF-1', 'you', { evict: undefined })
      else expect(method).toHaveBeenCalledWith('SULF-1', 'you')
    }
    const snapshot = vi.spyOn(svc, 'snapshotSandbox').mockReturnValue(receipt)
    await app.inject({
      method: 'POST',
      url: '/sandboxes/SULF-1/snapshot',
      payload: { actor: 'you', repo: 'svc-a' },
    })
    expect(snapshot).toHaveBeenCalledWith('SULF-1', { actor: 'you', repo: 'svc-a' })
    const wake = vi.spyOn(svc, 'wakeSandbox').mockReturnValue(receipt)
    await app.inject({
      method: 'POST',
      url: '/sandboxes/SULF-1/wake',
      payload: { actor: 'you', evict: true },
    })
    expect(wake).toHaveBeenCalledWith('SULF-1', 'you', { evict: true })
    for (const gone of ['discover', 'head'])
      expect(
        (await app.inject({ method: 'POST', url: `/sandboxes/SULF-1/${gone}`, payload: {} }))
          .statusCode,
      ).toBe(404)
    await app.inject('/repos/svc-a/logs/query?sandbox=SULF-1&workload=api')
    expect(query).toHaveBeenCalledWith(
      'svc-a',
      expect.objectContaining({ sandbox: 'SULF-1', workload: 'api' }),
    )
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/repos/svc-a/exec?sandbox=SULF-1',
          payload: { command: 'pwd' },
        })
      ).statusCode,
    ).toBe(400)
    const exec = await app.inject({
      method: 'POST',
      url: '/repos/svc-a/exec?sandbox=SULF-1&workload=api',
      payload: { command: 'pwd', actor: 'you' },
    })
    expect(exec.json()).toEqual({ ok: true, code: 0, stdout: 'slot', stderr: '' })
    expect(run).toHaveBeenCalledWith('svc-a', 'pwd', {
      sandbox: 'SULF-1',
      workload: 'api',
      actor: 'you',
    })
  } finally {
    await app.close()
  }
})

describe('stable sandbox link', () => {
  const sha = 'a'.repeat(40)
  const view = (
    over: Partial<Awaited<ReturnType<Service['sandboxStatus']>>>,
  ): Awaited<ReturnType<Service['sandboxStatus']>> => ({
    key: 'SULF-1',
    title: 'Fix login',
    slot: 'slot1',
    state: 'active',
    lastUsedAt: Date.now(),
    createdAt: Date.now(),
    activity: [],
    members: [
      {
        repo: 'svc-a',
        workload: 'api',
        mode: 'built',
        deployedSha: sha,
        build: { state: 'idle' },
      },
    ],
    snapshot: {
      at: Date.now(),
      actor: 'you',
      members: [
        {
          repo: 'svc-a',
          workload: 'api',
          sha,
          dirtyFiles: ['src/a.ts'],
          image: 'img',
          branch: 'SULF-1-fix',
          pr: { number: 7, url: 'https://github.com/team/svc-a/pull/7' },
        },
      ],
    },
    power: 'awake',
    healthy: true,
    ribbon: 'awake',
    urls: ['https://slot1.example/'],
    link: 'http://127.0.0.1:7717/s/SULF-1',
    markdown: '',
    expiresAt: 0,
    pool: [{ slot: 'slot1', key: 'SULF-1' }],
    ...over,
  })
  it('redirects an awake healthy sandbox and leaves waking to the page', async () => {
    const { svc } = makeService()
    const app = buildApp(svc)
    const status = vi.spyOn(svc, 'sandboxStatus').mockResolvedValue(view({}))
    const wake = vi.spyOn(svc, 'wakeSandbox').mockReturnValue({ operationId: 'op1' })
    try {
      const awake = await app.inject('/s/SULF-1')
      expect(awake.statusCode).toBe(302)
      expect(awake.headers.location).toBe('https://slot1.example/')
      expect(wake).not.toHaveBeenCalled()
      status.mockResolvedValue(view({ power: 'asleep', healthy: false, ribbon: 'asleep' }))
      const asleep = await app.inject('/s/SULF-1')
      expect(asleep.statusCode).toBe(200)
      expect(asleep.headers['content-type']).toContain('text/html')
      // GET never wakes: an <img> on any site could otherwise wake and extend a sandbox.
      expect(wake).not.toHaveBeenCalled()
      expect(asleep.body).toContain('Waking the sandbox')
      expect(asleep.body).toContain('+1 files')
      expect(asleep.body).toContain(`SULF-1-fix @ ${sha.slice(0, 7)}`)
      expect(asleep.body).toContain('href="https://github.com/team/svc-a/pull/7">PR #7<')
      expect(asleep.body).toContain('"poll":true')
      expect(asleep.body).toContain('"wake":true')
      status.mockResolvedValue(view({ power: 'asleep', healthy: false, ribbon: 'building' }))
      const building = await app.inject('/s/SULF-1')
      expect(building.body).toContain('Build in progress')
      expect(building.body).toContain('"wake":false')
      expect(wake).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })
  it('offers restore for expired snapshots, names the eviction candidate, and 404s unknown keys', async () => {
    const { svc } = makeService()
    const app = buildApp(svc)
    const status = vi.spyOn(svc, 'sandboxStatus').mockResolvedValue(
      view({
        slot: undefined,
        state: 'expired',
        power: 'asleep',
        healthy: false,
        ribbon: 'expired restorable',
        urls: [],
      }),
    )
    const wake = vi.spyOn(svc, 'wakeSandbox').mockReturnValue({ operationId: 'op1' })
    try {
      const restorable = await app.inject('/s/SULF-1')
      expect(restorable.statusCode).toBe(200)
      expect(restorable.body).toContain('>Restore<')
      expect(restorable.body).toContain('"evict":false')
      expect(wake).not.toHaveBeenCalled()
      status.mockResolvedValue(
        view({
          slot: undefined,
          state: 'expired',
          power: 'asleep',
          healthy: false,
          ribbon: 'expired restorable',
          urls: [],
          evictionCandidate: 'SULF-9',
        }),
      )
      const full = await app.inject('/s/SULF-1')
      expect(full.body).toContain('Evict SULF-9 and restore')
      expect(full.body).toContain('"evict":true')
      status.mockResolvedValue(
        view({
          slot: undefined,
          state: 'expired',
          snapshot: undefined,
          ribbon: 'expired',
          urls: [],
        }),
      )
      const gone = await app.inject('/s/SULF-1')
      expect(gone.statusCode).toBe(410)
      expect(gone.body).toContain('aged out')
      status.mockRejectedValue(new Error('unknown sandbox: SULF-1'))
      const missing = await app.inject('/s/SULF-1')
      expect(missing.statusCode).toBe(404)
      expect(missing.body).toContain('No sandbox is recorded')
      status.mockResolvedValue(
        view({
          title: '<b>x</b>',
          power: 'asleep',
          healthy: false,
          ribbon: 'failed',
          state: 'failed',
          error: 'Build failed',
        }),
      )
      const failed = await app.inject('/s/SULF-1')
      expect(failed.body).toContain('&lt;b&gt;x&lt;/b&gt;')
      expect(failed.body).toContain('Build failed')
      expect(failed.body).toContain('Build logs')
    } finally {
      await app.close()
    }
  })
})
