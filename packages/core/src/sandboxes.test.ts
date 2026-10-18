import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Operations } from './operations.js'
import { type SandboxMemberInput, Sandboxes, isExpired, staleMembers } from './sandboxes.js'
import { Service } from './service.js'
import { StateStore } from './stateStore.js'
import { Supervisor } from './supervisor.js'

const sha1 = 'a'.repeat(40)
const sha2 = 'b'.repeat(40)
const input: SandboxMemberInput = {
  repo: 'app',
  workload: 'api',
  source: { kind: 'branch', ref: 'ticket' },
}
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sandboxes-'))
  vi.stubEnv('DEVDOCK_SANDBOX_NAMESPACES', 'slot1,slot2')
  vi.stubEnv('DEVDOCK_SANDBOX_TTL_HOURS', '24')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function fixture(instanceId = 'machine1') {
  const repoPath = join(root, 'app')
  mkdirSync(repoPath, { recursive: true })
  writeFileSync(join(repoPath, 'devspace.yaml'), 'version: v2beta1\nname: app\n')
  const store = new StateStore(join(root, `state-${instanceId}.json`))
  const operations = new Operations(join(root, `operations-${instanceId}.json`))
  const leases = new Map<
    string,
    { metadata: { resourceVersion: string }; data: Record<string, string> }
  >()
  const deployments = new Map<string, number>()
  let head = sha1
  let version = 1
  const runner = vi.fn(async (cmd: string, args: string[], options?: { cwd?: string }) => {
    let stdout = ''
    const slot = args[args.indexOf('-n') + 1] ?? ''
    if (cmd === 'kubectl') {
      if (args[0] === 'get' && args[1] === 'configmap')
        stdout = leases.has(slot) ? JSON.stringify(leases.get(slot)) : ''
      if (args[0] === 'create') {
        if (leases.has(slot)) return { code: 1, stdout: '', stderr: 'AlreadyExists' }
        const data: Record<string, string> = {}
        for (const arg of args.filter((a) => a.startsWith('--from-literal='))) {
          const entry = arg.slice('--from-literal='.length)
          const index = entry.indexOf('=')
          data[entry.slice(0, index)] = entry.slice(index + 1)
        }
        leases.set(slot, { metadata: { resourceVersion: String(version++) }, data })
      }
      if (args[0] === 'patch' && args[1] === 'configmap') {
        const patches = JSON.parse(args[args.indexOf('-p') + 1] ?? '') as {
          op: string
          path: string
          value: string
        }[]
        const lease = leases.get(slot)
        if (!lease || lease.metadata.resourceVersion !== patches[0]?.value)
          return { code: 1, stdout: '', stderr: 'Conflict' }
        for (const p of patches.filter((p) => p.op === 'add'))
          lease.data[p.path.slice('/data/'.length)] = p.value
        lease.metadata.resourceVersion = String(version++)
      }
      if (args[0] === 'delete') leases.delete(slot)
      if (args[1] === 'deployments')
        stdout = JSON.stringify({
          items: [...deployments].map(([name, replicas]) => ({
            metadata: { name },
            spec: { replicas },
          })),
        })
      if (args[1] === 'ingresses')
        stdout =
          '{"items":[{"spec":{"rules":[{"host":"slot.example","http":{"paths":[{"path":"/app"}]}}]}}]}'
      if (args[0] === 'patch' && args[1] === 'deployment')
        deployments.set(
          args[2] ?? '',
          JSON.parse(args[args.indexOf('-p') + 1] ?? '{}').spec.replicas as number,
        )
    }
    if (cmd === 'git' && args[0] === 'rev-parse') stdout = head
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') {
      const path = args[3] as string
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, 'devspace.yaml'), readFileSync(join(repoPath, 'devspace.yaml')))
    }
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove')
      rmSync(args[3] as string, { recursive: true, force: true })
    if (cmd === 'gh')
      stdout =
        '[{"number":7,"url":"https://github.com/team/app/pull/7","headRefName":"SULF-1-fix"}]'
    void options
    return { code: 0, stdout, stderr: '' }
  })
  const supervisor = new Supervisor(runner)
  const sandbox = vi
    .spyOn(supervisor, 'sandbox')
    .mockResolvedValue({ code: 0, stdout: '', stderr: '' })
  const available = vi.fn(async () => {})
  const emit = vi.fn()
  const core = new Sandboxes({
    store,
    operations,
    runner,
    kubectl: runner,
    supervisor,
    instanceId,
    repos: () => [
      {
        id: 'app',
        name: 'app',
        path: repoPath,
        configPath: join(repoPath, 'devspace.yaml'),
        ports: [],
        session: 'devdock-app',
        workloads: ['api', 'worker', 'cron'],
        defaultWorkload: 'api',
      },
    ],
    namespace: async () => 'personal',
    assertAvailable: available,
    authorize: async () => {},
    emit,
  })
  const done = async (receipt: { operationId: string }) => {
    for (let i = 0; i < 100 && operations.get(receipt.operationId).state === 'active'; i++)
      await new Promise((r) => setTimeout(r, 0))
    return operations.get(receipt.operationId)
  }
  return {
    core,
    store,
    operations,
    leases,
    deployments,
    runner,
    sandbox,
    available,
    emit,
    done,
    setHead: (sha: string) => {
      head = sha
    },
  }
}

describe('sandbox lifecycle', () => {
  it('records controller heads without extending idle or expiry clocks', async () => {
    const f = fixture()
    await f.done(await f.core.create({ key: 'SULF-1', actor: 'you', members: [input] }))
    const record = f.store.getSandbox('SULF-1')
    if (!record) throw new Error('missing sandbox')
    record.lastUsedAt = 123
    f.store.setSandbox(record)
    await f.core.recordHead('SULF-1', input, sha2, 'controller', false, { touch: false })
    expect(f.store.getSandbox('SULF-1')?.lastUsedAt).toBe(123)
    expect(f.store.getSandbox('SULF-1')?.activity.at(-1)).toMatchObject({
      actor: 'controller',
      action: 'head',
    })
    const mirrored = JSON.parse(f.leases.get('slot1')?.data.sandbox ?? '{}') as {
      lastUsedAt: number
    }
    expect(mirrored.lastUsedAt).toBe(123)
    await f.core.recordHead('SULF-1', input, sha1, 'you')
    expect(f.store.getSandbox('SULF-1')?.lastUsedAt).toBeGreaterThan(123)
  })
  it('leases before building, defaults asleep, derives URLs and wakes only explicit members', async () => {
    const f = fixture()
    expect(
      (await f.done(await f.core.create({ key: 'SULF-1', actor: 'you', members: [input] }))).state,
    ).toBe('succeeded')
    expect(f.store.getSandbox('SULF-1')?.members[0]?.deployedSha).toBe(sha1)
    expect(f.leases.get('slot1')?.data.members).toContain(sha1)
    expect((await f.core.status('SULF-1')).urls).toEqual(['https://slot.example/app'])
    expect((await f.core.list())[0]?.personal).toBe(true)
    await f.done(f.core.wake('SULF-1', 'you'))
    expect(f.deployments.get('app-api')).toBe(1)
    expect(f.deployments.has('app-worker')).toBe(false)
    expect((await f.core.status('SULF-1')).power).toBe('awake')
    await f.done(f.core.sleep('SULF-1', 'sleeper'))
    expect(f.deployments.get('app-api')).toBe(0)
    expect(f.sandbox).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'slot1' }),
      'deploy',
      false,
    )
  })
  it('resets in a fresh worktree when the build worktree lives on another machine', async () => {
    const f = fixture()
    await f.done(await f.core.create({ key: 'SULF-1', members: [input], actor: 'you' }))
    for (const [cmd, args] of f.runner.mock.calls)
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add')
        rmSync(args[3] as string, { recursive: true, force: true })
    expect((await f.done(f.core.expire('SULF-1', 'you'))).state).toBe('succeeded')
    expect(readdirSync(join(root, 'app')).filter((n) => n.startsWith('.devdock-sandbox'))).toEqual(
      [],
    )
  })
  it('fails when all slots are occupied without deploying', async () => {
    const f = fixture()
    const busy = { metadata: { resourceVersion: '1' }, data: { key: 'other', members: '[]' } }
    f.leases.set('slot1', busy)
    f.leases.set('slot2', busy)
    const result = await f.done(
      await f.core.create({ key: 'SULF-1', members: [input], actor: 'you' }),
    )
    expect(result.state).toBe('failed')
    expect(result.logs.at(-1)?.message).toContain('pool full')
    expect(f.sandbox).not.toHaveBeenCalled()
  })
  it('keeps the record and SHAs on expiry, rebuilds all members asleep, deletes only explicitly', async () => {
    const f = fixture()
    await f.done(await f.core.create({ key: 'SULF-1', members: [input], actor: 'you' }))
    const s = f.store.getSandbox('SULF-1')
    expect(s && isExpired(s, s.lastUsedAt + 86400000, 86400000)).toBe(true)
    await f.done(f.core.expire('SULF-1', 'expiry'))
    expect(f.store.getSandbox('SULF-1')).toMatchObject({
      state: 'expired',
      slot: undefined,
      members: [{ deployedSha: sha1 }],
    })
    expect(f.leases.size).toBe(0)
    f.sandbox.mockClear()
    await f.done(f.core.build('SULF-1', { actor: 'you' }))
    expect(f.sandbox).toHaveBeenCalledWith(expect.anything(), 'deploy', false)
    await f.done(f.core.delete('SULF-1', 'you'))
    expect(f.store.getSandbox('SULF-1')).toBeUndefined()
  })
  it('builds the latest head after an in-flight head change and caps activity', async () => {
    const f = fixture()
    let changes = 0
    f.sandbox.mockImplementation(async (_repo, action) => {
      if (action === 'deploy' && changes++ === 0)
        await f.core.recordHead('SULF-1', input, sha2, 'poller')
      return { code: 0, stdout: '', stderr: '' }
    })
    await f.done(await f.core.create({ key: 'SULF-1', members: [input], actor: 'you' }))
    expect(f.sandbox.mock.calls.filter((c) => c[1] === 'deploy')).toHaveLength(2)
    expect(f.store.getSandbox('SULF-1')?.members[0]?.deployedSha).toBe(sha2)
    for (let i = 0; i < 210; i++) await f.core.recordHead('SULF-1', input, sha2, 'poller')
    expect(f.store.getSandbox('SULF-1')?.activity).toHaveLength(200)
    expect((await f.core.status('SULF-1')).activity).toHaveLength(50)
  })
  it('marks merged PRs without building them', async () => {
    const f = fixture()
    await f.done(await f.core.create({ key: 'SULF-1', members: [input], actor: 'you' }))
    await f.core.recordHead('SULF-1', input, sha2, 'poller', true)
    expect(
      staleMembers(
        f.store.getSandbox('SULF-1') as NonNullable<ReturnType<StateStore['getSandbox']>>,
      ),
    ).toEqual([])
    f.sandbox.mockClear()
    await f.done(f.core.build('SULF-1', { actor: 'you', force: true }))
    expect(f.sandbox).not.toHaveBeenCalled()
    expect((await f.core.status('SULF-1')).allMerged).toBe(true)
  })
  it('recovers owned and unowned ConfigMaps, ignores another instance and interrupts operations', async () => {
    const f = fixture()
    const m = {
      ...input,
      mode: 'built',
      build: { state: 'building', instanceId: 'machine1' },
      deployedSha: sha1,
    }
    f.leases.set('slot1', {
      metadata: { resourceVersion: '1' },
      data: { key: 'SULF-1', instanceId: 'machine1', members: JSON.stringify([m]) },
    })
    f.leases.set('slot2', {
      metadata: { resourceVersion: '1' },
      data: { key: 'OTHER', instanceId: 'machine2', members: JSON.stringify([m]) },
    })
    const op = f.operations.create('sandbox:SULF-1', '', 'slot1', 'build')
    await f.core.recover()
    expect(f.store.getSandbox('SULF-1')).toMatchObject({
      slot: 'slot1',
      members: [{ deployedSha: sha1, build: { state: 'failed' } }],
    })
    expect(f.store.getSandbox('OTHER')).toBeUndefined()
    expect(f.operations.get(op.id).state).toBe('interrupted')
    f.leases.set('slot2', {
      metadata: { resourceVersion: '1' },
      data: { key: 'FREE', members: JSON.stringify([m]) },
    })
    await f.core.recover()
    expect(f.store.getSandbox('FREE')).toBeDefined()
  })
  it('refuses a live personal release before acquiring or deploying', async () => {
    const f = fixture()
    vi.stubEnv('DEVDOCK_SANDBOX_NAMESPACES', 'personal')
    f.available.mockRejectedValue(new Error('Live dev session holds app-api in personal namespace'))
    const result = await f.done(
      await f.core.create({ key: 'SULF-1', members: [input], actor: 'you' }),
    )
    expect(result.state).toBe('failed')
    expect(f.leases.size).toBe(0)
    expect(f.sandbox).not.toHaveBeenCalled()
  })
  it('requires actors, validates members, discovers PRs and isolates multi-workload worktrees', async () => {
    const f = fixture()
    await expect(f.core.create({ key: 'SULF-1', members: [input], actor: '' })).rejects.toThrow(
      'actor required',
    )
    await expect(
      f.core.create({ key: 'SULF-1', members: [{ ...input, workload: 'nope' }], actor: 'you' }),
    ).rejects.toThrow('unknown workload')
    expect(await f.core.discover('SULF-1')).toEqual([
      {
        repo: 'app',
        workload: 'api',
        source: {
          kind: 'pr',
          repoSlug: 'team/app',
          number: 7,
          url: 'https://github.com/team/app/pull/7',
        },
      },
    ])
    await f.done(
      await f.core.create({
        key: 'SULF-1',
        actor: 'you',
        members: [input, { ...input, workload: 'worker' }],
      }),
    )
    const roots = f.sandbox.mock.calls.filter((c) => c[1] === 'deploy').map((c) => c[0].root)
    expect(new Set(roots).size).toBe(2)
    expect(roots.every((r) => r?.startsWith(join(root, '.devdock-sb-slot1-')))).toBe(true)
  })
  it('retains failed builds for explicit retry, refuses concurrent operations and changed ownership', async () => {
    const f = fixture()
    f.sandbox.mockResolvedValue({ code: 1, stdout: '', stderr: 'Build failed' })
    const op = await f.core.create({ key: 'SULF-1', actor: 'you', members: [input] })
    expect(() => f.core.expire('SULF-1', 'you')).toThrow('already active')
    expect((await f.done(op)).state).toBe('failed')
    expect(f.store.getSandbox('SULF-1')?.members[0]?.build).toMatchObject({ state: 'failed' })
    const lease = f.leases.get('slot1')
    if (lease) lease.data.key = 'another'
    expect((await f.done(f.core.expire('SULF-1', 'you'))).state).toBe('failed')
    expect(f.store.getSandbox('SULF-1')?.slot).toBe('slot1')
  })
})

it('refuses real personal namespace dev sessions through the service', async () => {
  mkdirSync(join(root, 'app'))
  writeFileSync(join(root, 'app', 'devspace.yaml'), 'name: app\n')
  vi.stubEnv('DEVDOCK_SANDBOX_NAMESPACES', 'personal')
  const runner = vi.fn(async (cmd: string, args: string[]) => {
    const stdout =
      cmd === 'kubectl' && args[0] === 'config'
        ? 'personal'
        : cmd === 'kubectl' && args[1] === 'pods'
          ? '{"items":[]}'
          : cmd === 'kubectl' && args[1] === 'deployments'
            ? '{"items":[]}'
            : ''
    return { code: 0, stdout, stderr: '' }
  })
  const supervisor = new Supervisor(runner)
  vi.spyOn(supervisor, 'hasSession').mockResolvedValue(true)
  const svc = new Service(
    { roots: [root], stateFile: join(root, 'service.json') },
    { runner, supervisor },
  )
  svc.rescan()
  const receipt = await svc.createSandbox({ key: 'SULF-1', actor: 'you', members: [input] })
  for (let i = 0; i < 100 && svc.getOperation(receipt.operationId).state === 'active'; i++)
    await new Promise((r) => setTimeout(r, 0))
  expect(svc.getOperation(receipt.operationId).logs.at(-1)?.message).toContain('Live dev session')
  expect(runner.mock.calls.some((c) => c[0] === 'kubectl' && c[1][0] === 'create')).toBe(false)
})

it('refuses a slot operation held by another machine', async () => {
  const f = fixture()
  await f.done(await f.core.create({ key: 'SULF-1', members: [input], actor: 'you' }))
  const lease = f.leases.get('slot1')
  if (!lease) throw new Error('missing fixture lease')
  lease.data.operation = JSON.stringify({ instanceId: 'other', operationId: 'busy' })
  f.runner.mockClear()
  const result = await f.done(f.core.expire('SULF-1', 'you'))
  expect(result.state).toBe('failed')
  expect(result.logs.at(-1)?.message).toContain('another instance')
  expect(f.runner.mock.calls.some(([cmd, args]) => cmd === 'kubectl' && args[0] === 'delete')).toBe(
    false,
  )
  expect(f.leases.get('slot1')?.data.operation).toContain('busy')
})

it('resets a removed release, drops its worktree and retains the other members', async () => {
  const f = fixture()
  await f.done(
    await f.core.create({
      key: 'SULF-1',
      members: [input, { ...input, workload: 'worker' }],
      actor: 'you',
    }),
  )
  f.sandbox.mockClear()
  const op = await f.done(
    f.core.update('SULF-1', { actor: 'you', remove: [{ repo: 'app', workload: 'worker' }] }),
  )
  expect(op.state).toBe('succeeded')
  expect(f.sandbox).toHaveBeenCalledWith(expect.objectContaining({ name: 'app-worker' }), 'reset')
  expect(f.store.getSandbox('SULF-1')?.members.map((m) => m.workload)).toEqual(['api'])
})

it('refreshes branch heads and restarts only members that were awake', async () => {
  const f = fixture()
  await f.done(
    await f.core.create({
      key: 'SULF-1',
      members: [input, { ...input, workload: 'worker' }],
      actor: 'you',
    }),
  )
  f.deployments.set('app-api', 1)
  f.deployments.set('app-worker', 0)
  f.setHead(sha2)
  f.sandbox.mockClear()
  await f.done(f.core.build('SULF-1', { actor: 'you' }))
  expect(f.sandbox).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'app-api' }),
    'deploy',
    true,
  )
  expect(f.sandbox).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'app-worker' }),
    'deploy',
    false,
  )
  const restarts = f.runner.mock.calls.filter(
    ([cmd, args]) => cmd === 'kubectl' && args[0] === 'rollout',
  )
  expect(restarts.map((c) => c[1][2])).toEqual(['deployment/app-api'])
  expect(f.store.getSandbox('SULF-1')?.members.every((m) => m.deployedSha === sha2)).toBe(true)
})

it('fetches PR heads from their target repository and appends development placement after persistent values', async () => {
  const f = fixture()
  await f.done(
    await f.core.create({
      key: 'SULF-1',
      members: [
        {
          ...input,
          source: {
            kind: 'pr',
            repoSlug: 'team/app',
            number: 42,
            url: 'https://github.com/team/app/pull/42',
          },
        },
      ],
      actor: 'you',
    }),
  )
  expect(f.runner).toHaveBeenCalledWith(
    'git',
    ['fetch', '--', 'https://github.com/team/app.git', 'pull/42/head'],
    expect.anything(),
  )
  const repo = f.sandbox.mock.calls.find((c) => c[1] === 'deploy')?.[0]
  if (!repo) throw new Error('missing deployment')
  const yaml = readFileSync(repo.configPath, 'utf8')
  expect(yaml).toContain('deployments.api.helm.valuesFiles')
  expect(yaml).toContain('create_deployments default')
  expect(readFileSync(repo.configPath.replace('.yaml', '-values.yaml'), 'utf8')).toContain(
    'workload: development',
  )
  expect(readFileSync(join(root, 'app', 'devspace.yaml'), 'utf8')).toBe(
    'version: v2beta1\nname: app\n',
  )
})

it('targets sandbox deployments for logs and exec and requires an exec actor', async () => {
  const f = fixture()
  await f.done(await f.core.create({ key: 'SULF-1', members: [input], actor: 'you' }))
  const svc = new Service(
    { roots: [root], stateFile: join(root, 'state-machine1.json') },
    { runner: f.runner },
  )
  svc.rescan()
  await svc.queryLogs('app', { sandbox: 'SULF-1', workload: 'api', tail: 7 })
  expect(f.runner).toHaveBeenCalledWith(
    'kubectl',
    ['logs', 'deployment/app', '-n', 'slot1', '--tail', '7'],
    expect.anything(),
  )
  await expect(svc.runInWorkload('app', 'pwd', { sandbox: 'SULF-1' })).rejects.toThrow(
    'actor required',
  )
  await svc.runInWorkload('app', 'pwd', { sandbox: 'SULF-1', actor: 'you' })
  expect(f.runner).toHaveBeenCalledWith(
    'kubectl',
    ['exec', 'deployment/app', '-n', 'slot1', '--', 'sh', '-c', 'pwd'],
    expect.anything(),
  )
  expect(
    new StateStore(join(root, 'state-machine1.json')).getSandbox('SULF-1')?.activity.at(-1),
  ).toMatchObject({ actor: 'you', action: 'exec' })
})
