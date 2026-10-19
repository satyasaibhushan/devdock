import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
      writeFileSync(join(path, 'Dockerfile'), 'FROM scratch\nCOPY . .\n')
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
  const sandboxResult = async (_repo: unknown, action: string) => ({
    code: 0,
    stdout:
      action === 'print'
        ? 'images:\n  app:\n    image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/devspace\n    context: .\n    dockerfile: Dockerfile\n'
        : action === 'image'
          ? 'SANDBOX_IMAGE=missing\n'
          : action === 'architecture'
            ? 'info SANDBOX_ARCH=linux/arm64\n'
            : '',
    stderr: '',
  })
  const sandbox = vi.spyOn(supervisor, 'sandbox').mockImplementation(sandboxResult)
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
    sandboxResult,
    available,
    emit,
    done,
    repoPath,
    setHead: (sha: string) => {
      head = sha
    },
    imagePresent: () =>
      sandbox.mockImplementation(async (repo, action) =>
        action === 'image'
          ? { code: 0, stdout: `SANDBOX_IMAGE=sha256:${'d'.repeat(64)}\n`, stderr: '' }
          : sandboxResult(repo, action),
      ),
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
    expect(f.sandbox).toHaveBeenCalledWith(expect.anything(), 'deploy', false, false)
    await f.done(f.core.delete('SULF-1', 'you'))
    expect(f.store.getSandbox('SULF-1')).toBeUndefined()
  })
  it('builds the latest head after an in-flight head change and caps activity', async () => {
    const f = fixture()
    let changes = 0
    f.sandbox.mockImplementation(async (_repo, action) => {
      if (action === 'deploy' && changes++ === 0)
        await f.core.recordHead('SULF-1', input, sha2, 'poller')
      return f.sandboxResult(_repo, action)
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

it('refreshes branch heads and lets Helm roll changed images', async () => {
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
    false,
  )
  expect(f.sandbox).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'app-worker' }),
    'deploy',
    false,
    false,
  )
  const restarts = f.runner.mock.calls.filter(
    ([cmd, args]) => cmd === 'kubectl' && args[0] === 'rollout',
  )
  expect(restarts).toHaveLength(0)
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

it('finishes other members and mirrors every failure without configmap conflicts', async () => {
  const f = fixture()
  const started: string[] = []
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.sandbox.mockImplementation(async (repo, action) => {
    if (action !== 'deploy') {
      const result = await f.sandboxResult(repo, action)
      if (action === 'print') result.stdout += `    buildArgs:\n      WORKLOAD: ${repo.name}\n`
      return result
    }
    started.push(repo.name)
    if (repo.name === 'app-api') {
      await gate
      return { code: 1, stdout: '', stderr: 'api build failed' }
    }
    release()
    return { code: 0, stdout: '', stderr: '' }
  })
  const result = await f.done(
    await f.core.create({
      key: 'parallel',
      actor: 'you',
      members: [input, { ...input, workload: 'worker' }],
    }),
  )
  expect(started.sort()).toEqual(['app-api', 'app-worker'])
  expect(result.state).toBe('failed')
  expect(result.logs.at(-1)?.message).toContain('api build failed')
  expect(f.store.getSandbox('parallel')?.members.map((m) => m.build.state)).toEqual([
    'failed',
    'idle',
  ])
  const mirrored = JSON.parse(f.leases.get('slot1')?.data.members ?? '[]') as {
    build: { state: string }
  }[]
  expect(mirrored.map((m) => m.build.state)).toEqual(['failed', 'idle'])
})

it('deploys an existing ECR image with skip-build and freezes effective build settings', async () => {
  const f = fixture()
  f.sandbox.mockImplementation(async (repo, action) =>
    action === 'image'
      ? { code: 0, stdout: `SANDBOX_IMAGE=sha256:${'c'.repeat(64)}\n`, stderr: '' }
      : f.sandboxResult(repo, action),
  )
  expect(
    (await f.done(await f.core.create({ key: 'cached', actor: 'you', members: [input] }))).state,
  ).toBe('succeeded')
  const call = f.sandbox.mock.calls.find((c) => c[1] === 'deploy')
  expect(call?.slice(1)).toEqual(['deploy', false, true])
  const repo = call?.[0]
  if (!repo) throw new Error('missing deployed repo')
  const text = readFileSync(repo.configPath, 'utf8')
  expect(text).toContain(`- ${repo.varDefaults?.IMAGE_TAG}-persistent`)
  expect(text).not.toContain('buildKit:')
  expect(text).not.toContain('sb-cache-')
  expect(text).not.toContain('slot1-persistent-cache')
})

it.each(['linux/arm64', 'linux/amd64', '', 'not an architecture'])(
  'fingerprints Docker architecture and fails closed for invalid output: %s',
  async (architecture) => {
    const f = fixture()
    f.sandbox.mockImplementation(async (repo, action) =>
      action === 'architecture'
        ? { code: 0, stdout: `info SANDBOX_ARCH=${architecture}\n`, stderr: '' }
        : f.sandboxResult(repo, action),
    )
    const result = await f.done(
      await f.core.create({ key: 'arch', actor: 'you', members: [input] }),
    )
    expect(result.state).toBe(architecture.startsWith('linux/') ? 'succeeded' : 'failed')
    if (result.state === 'failed') {
      expect(result.logs.at(-1)?.message).toContain('Docker builder architecture')
      expect(f.sandbox.mock.calls.some((c) => c[1] === 'deploy')).toBe(false)
    }
  },
)

it('preserves the existing BuildKit builder and cache options while stabilizing refs', async () => {
  const f = fixture()
  f.sandbox.mockImplementation(async (repo, action) => {
    const result = await f.sandboxResult(repo, action)
    if (action === 'print')
      result.stdout += `    buildKit:
      inCluster:
        namespace: builders
      args:
        - --cache-to=type=registry,mode=max,ref=old-slot-cache
        - --cache-from
        - type=registry,ref=old-slot-cache
`
    return result
  })
  const result = await f.done(await f.core.create({ key: 'kit', actor: 'you', members: [input] }))
  expect(result.state).toBe('succeeded')
  const repo = f.sandbox.mock.calls.find((c) => c[1] === 'deploy')?.[0]
  if (!repo) throw new Error('missing deployed repo')
  const text = readFileSync(repo.configPath, 'utf8')
  expect(text).toContain('namespace: builders')
  expect(text).toContain('--platform=linux/amd64')
  expect(text).toContain(
    'type=registry,mode=max,ref=123456789012.dkr.ecr.us-east-1.amazonaws.com/devspace:sb-cache-',
  )
  expect(text).not.toContain('old-slot-cache')
  expect(f.sandbox.mock.calls.some((c) => c[1] === 'architecture')).toBe(false)
})

it('names the image and tag when an ECR lookup fails', async () => {
  const f = fixture()
  f.sandbox.mockImplementation(async (repo, action) =>
    action === 'image'
      ? { code: 1, stdout: '', stderr: 'AccessDeniedException' }
      : f.sandboxResult(repo, action),
  )
  const result = await f.done(
    await f.core.create({ key: 'denied', actor: 'you', members: [input] }),
  )
  expect(result.state).toBe('failed')
  expect(result.logs.at(-1)?.message).toMatch(
    /lookup failed for .*\/devspace:sb-[a-f0-9]+-persistent/,
  )
  expect(f.sandbox.mock.calls.some((c) => c[1] === 'deploy')).toBe(false)
})

describe('snapshots', () => {
  it('bakes a worktree with its uncommitted files, leaves the checkout alone and records dirty paths', async () => {
    const f = fixture()
    const wt = join(root, 'wt')
    mkdirSync(join(wt, 'src'), { recursive: true })
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: wt,
        stdio: 'pipe',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
      })
        .toString()
        .trim()
    git('init', '-q')
    git('config', 'user.email', 'x@example.com')
    git('config', 'user.name', 'x')
    writeFileSync(join(wt, 'devspace.yaml'), 'version: v2beta1\nname: app\n')
    writeFileSync(join(wt, 'Dockerfile'), 'FROM scratch\nCOPY . .\n')
    writeFileSync(join(wt, '.gitignore'), '*.log\n')
    writeFileSync(join(wt, 'src', 'a.ts'), 'old\n')
    writeFileSync(join(wt, 'src', 'gone.ts'), 'bye\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
    const head = git('rev-parse', 'HEAD')
    writeFileSync(join(wt, 'src', 'a.ts'), 'new\n')
    writeFileSync(join(wt, 'src', 'b.ts'), 'untracked\n')
    writeFileSync(join(wt, 'debug.log'), 'ignored\n')
    rmSync(join(wt, 'src', 'gone.ts'))
    const mocked = f.runner.getMockImplementation()
    f.runner.mockImplementation(async (cmd, args, options) =>
      cmd === 'git' && options?.cwd === wt
        ? { code: 0, stdout: git(...args), stderr: '' }
        : (mocked as NonNullable<typeof mocked>)(cmd, args, options),
    )
    const seen: Record<string, boolean | string> = {}
    f.sandbox.mockImplementation(async (repo, action) => {
      if (action === 'deploy') {
        seen.root = repo.root
        seen.a = readFileSync(join(repo.root, 'src', 'a.ts'), 'utf8')
        seen.b = existsSync(join(repo.root, 'src', 'b.ts'))
        seen.log = existsSync(join(repo.root, 'debug.log'))
        seen.gone = existsSync(join(repo.root, 'src', 'gone.ts'))
      }
      return f.sandboxResult(repo, action)
    })
    const member: SandboxMemberInput = { ...input, source: { kind: 'worktree', path: wt } }
    const result = await f.done(
      await f.core.create({ key: 'SULF-1', actor: 'agent', members: [member] }),
    )
    expect(result.state).toBe('succeeded')
    expect(seen).toEqual({
      root: expect.stringContaining('.devdock-sb-slot1-'),
      a: 'new\n',
      b: true,
      log: false,
      gone: false,
    })
    expect(existsSync(seen.root as string)).toBe(false)
    expect(readdirSync(wt).filter((n) => n.startsWith('.devdock'))).toEqual([])
    expect(f.store.getSandbox('SULF-1')?.snapshot).toMatchObject({
      actor: 'agent',
      members: [
        {
          repo: 'app',
          workload: 'api',
          sha: head,
          dirtyFiles: ['src/a.ts', 'src/b.ts', 'src/gone.ts'],
          image: expect.stringContaining('/devspace:sb-'),
        },
      ],
    })
    const view = await f.core.status('SULF-1')
    expect(view.link).toBe('http://127.0.0.1:7717/s/SULF-1')
    expect(view.markdown).toContain(`app api ${head} (+3 uncommitted files)`)
    await expect(
      f.core.create({
        key: 'SULF-2',
        actor: 'agent',
        members: [{ ...input, source: { kind: 'worktree', path: 'relative' } }],
      }),
    ).rejects.toThrow('absolute')
  })
  it('rejects a worktree with a submodule and removes its partial build copy', async () => {
    const f = fixture()
    const wt = join(root, 'wt')
    mkdirSync(join(wt, 'vendor', 'lib'), { recursive: true })
    const mocked = f.runner.getMockImplementation()
    f.runner.mockImplementation(async (cmd, args, options) =>
      cmd === 'git' && options?.cwd === wt
        ? {
            code: 0,
            stdout: args[0] === 'rev-parse' ? sha1 : 'Dockerfile\0vendor/lib\0',
            stderr: '',
          }
        : (mocked as NonNullable<typeof mocked>)(cmd, args, options),
    )
    writeFileSync(join(wt, 'Dockerfile'), 'FROM scratch\n')
    writeFileSync(join(wt, 'devspace.yaml'), 'version: v2beta1\nname: app\n')
    const member: SandboxMemberInput = { ...input, source: { kind: 'worktree', path: wt } }
    const result = await f.done(
      await f.core.create({ key: 'SULF-1', actor: 'agent', members: [member] }),
    )
    expect(result.state).toBe('failed')
    expect(result.logs.at(-1)?.message).toBe(
      'app:api: Submodules are not supported in worktree members: vendor/lib',
    )
    expect(readdirSync(dirname(f.repoPath)).filter((n) => n.includes('-build-'))).toEqual([])
  })
  it('records a snapshot after every full build and renders PR markdown against the source head', async () => {
    const f = fixture()
    await f.done(await f.core.create({ key: 'SULF-1', actor: 'you', members: [input] }))
    const saved = f.store.getSandbox('SULF-1')?.snapshot
    expect(saved).toMatchObject({
      actor: 'you',
      members: [{ sha: sha1, dirtyFiles: [], image: expect.stringContaining('-persistent') }],
    })
    let view = await f.core.status('SULF-1')
    expect(view.ribbon).toBe('asleep')
    expect(view.pool).toEqual([{ slot: 'slot1', key: 'SULF-1' }, { slot: 'slot2' }])
    expect(view.markdown).toBe(
      [
        'Sandbox SULF-1: asleep',
        'Stable link: http://127.0.0.1:7717/s/SULF-1',
        'Live URL: https://slot.example/app',
        '',
        '```',
        `app api ${sha1} = ticket head`,
        '```',
      ].join('\n'),
    )
    await f.core.recordHead('SULF-1', input, sha2, 'poller')
    view = await f.core.status('SULF-1')
    expect(view.markdown).toContain(`app api ${sha1} vs ticket head ${sha2}`)
    f.setHead(sha2)
    await f.done(f.core.snapshot('SULF-1', { actor: 'again' }))
    expect(f.store.getSandbox('SULF-1')?.snapshot).toMatchObject({
      actor: 'again',
      members: [{ sha: sha2 }],
    })
    expect(f.store.getSandbox('SULF-1')?.activity.map((a) => a.action)).toContain('snapshot')
  })
  it('restores an expired snapshot into a free slot from recorded images without rebuilding', async () => {
    const f = fixture()
    await f.done(await f.core.create({ key: 'SULF-1', actor: 'you', members: [input] }))
    const image = f.store.getSandbox('SULF-1')?.snapshot?.members[0]?.image
    await f.done(f.core.expire('SULF-1', 'expiry'))
    expect((await f.core.status('SULF-1')).ribbon).toBe('expired restorable')
    f.sandbox.mockClear()
    // A tag pruned from ECR inside the TTL fails the restore instead of deploying a dead image.
    let result = await f.done(f.core.wake('SULF-1', 'link'))
    expect(result.state).toBe('failed')
    expect(result.logs.at(-1)?.message).toBe(`Snapshot image ${image} is gone; rebuild the sandbox`)
    expect(f.sandbox.mock.calls.some((c) => c[1] === 'deploy')).toBe(false)
    expect(f.store.getSandbox('SULF-1')).toMatchObject({ state: 'expired', slot: undefined })
    expect(f.leases.has('slot1')).toBe(false)
    expect((await f.core.status('SULF-1')).ribbon).toBe('expired restorable')
    f.imagePresent()
    f.sandbox.mockClear()
    result = await f.done(f.core.wake('SULF-1', 'link'))
    expect(result.state).toBe('succeeded')
    const deploy = f.sandbox.mock.calls.find((c) => c[1] === 'deploy')
    expect(deploy?.slice(1)).toEqual(['deploy', true, true])
    expect(readFileSync(deploy?.[0].configPath as string, 'utf8')).toContain(`value: ${image}`)
    expect(f.store.getSandbox('SULF-1')).toMatchObject({ state: 'active', slot: 'slot1' })
    expect(f.deployments.get('app-api')).toBe(1)
    expect(f.store.getSandbox('SULF-1')?.activity).toContainEqual(
      expect.objectContaining({ action: 'restore', actor: 'link' }),
    )
  })
  it('refuses to wake an expired sandbox without a snapshot and drops aged snapshots', async () => {
    const f = fixture()
    await f.done(await f.core.create({ key: 'SULF-1', actor: 'you', members: [input] }))
    await f.done(f.core.expire('SULF-1', 'expiry'))
    const record = f.store.getSandbox('SULF-1')
    if (!record) throw new Error('missing sandbox')
    record.expiredAt = Date.now() - 31 * 86_400_000
    f.store.setSandbox(record)
    expect((await f.core.status('SULF-1')).ribbon).toBe('expired')
    expect(f.store.getSandbox('SULF-1')?.snapshot).toBeUndefined()
    expect(() => f.core.wake('SULF-1', 'link')).toThrow('rebuild first')
  })
  it('names the least recently used asleep sandbox when the pool is full and evicts it on request', async () => {
    const f = fixture()
    await f.done(await f.core.create({ key: 'SULF-1', actor: 'you', members: [input] }))
    await f.done(f.core.expire('SULF-1', 'expiry'))
    await f.done(await f.core.create({ key: 'SULF-2', actor: 'you', members: [input] }))
    await f.done(await f.core.create({ key: 'SULF-3', actor: 'you', members: [input] }))
    const second = f.store.getSandbox('SULF-2')
    if (!second) throw new Error('missing sandbox')
    second.lastUsedAt -= 60_000
    f.store.setSandbox(second)
    f.imagePresent()
    // No deployments yet means nothing provably asleep, so nothing to evict.
    let result = await f.done(f.core.wake('SULF-1', 'link'))
    expect(result.state).toBe('failed')
    expect(result.logs.at(-1)?.message).toContain('no asleep sandbox to evict')
    f.deployments.set('app-api', 0)
    expect((await f.core.status('SULF-1')).evictionCandidate).toBe('SULF-2')
    result = await f.done(f.core.wake('SULF-1', 'link'))
    expect(result.state).toBe('failed')
    expect(result.logs.at(-1)?.message).toBe(
      'Sandbox namespace pool full; evict asleep sandbox SULF-2 to restore',
    )
    expect(f.store.getSandbox('SULF-1')?.state).toBe('expired')
    expect(f.store.getSandbox('SULF-2')?.state).toBe('active')
    // An awake sandbox is never a candidate.
    f.deployments.set('app-api', 1)
    result = await f.done(f.core.wake('SULF-1', 'link', { evict: true }))
    expect(result.logs.at(-1)?.message).toContain('no asleep sandbox to evict')
    f.deployments.set('app-api', 0)
    result = await f.done(f.core.wake('SULF-1', 'link', { evict: true }))
    expect(result.state).toBe('succeeded')
    expect(f.store.getSandbox('SULF-2')).toMatchObject({ state: 'expired', slot: undefined })
    expect(f.store.getSandbox('SULF-1')).toMatchObject({ state: 'active', slot: 'slot1' })
    expect(f.store.getSandbox('SULF-3')?.slot).toBe('slot2')
  })
})
