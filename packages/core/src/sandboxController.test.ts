import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Operation } from './operations.js'
import { SandboxController } from './sandboxController.js'
import type { SandboxView } from './sandboxes.js'

const sha = 'a'.repeat(40)
const minute = 60_000
function sandbox(patch: Partial<SandboxView> = {}): SandboxView {
  return {
    key: 'ticket',
    slot: 'slot1',
    state: 'active',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    members: [
      {
        repo: 'app',
        workload: 'api',
        mode: 'built',
        deployedSha: sha,
        build: { state: 'idle' },
      },
    ],
    activity: [],
    power: 'awake',
    urls: [],
    memberUrls: {},
    expiresAt: 0,
    ...patch,
  }
}
function fixture(records: SandboxView[] = [sandbox()]) {
  let lock:
    | { metadata: { resourceVersion: string }; data: { holder: string; renewedAt: string } }
    | undefined
  let version = 0
  let conflict = false
  let namespace = 'personal'
  const kubectl = vi.fn(async (_cmd: string, args: string[]) => {
    let stdout = ''
    if (args[0] === 'get') stdout = lock ? JSON.stringify(lock) : ''
    if (args[0] === 'create') {
      if (lock) return { code: 1, stdout: '', stderr: 'AlreadyExists' }
      lock = {
        metadata: { resourceVersion: String(++version) },
        data: {
          holder:
            args
              .find((a) => a.startsWith('--from-literal=holder='))
              ?.split('=')
              .at(-1) ?? '',
          renewedAt: String(Date.now()),
        },
      }
    }
    if (args[0] === 'patch') {
      const patches = JSON.parse(args[args.indexOf('-p') + 1] ?? '') as {
        op: string
        path: string
        value: string
      }[]
      expect(patches[0]).toEqual({
        op: 'test',
        path: '/metadata/resourceVersion',
        value: lock?.metadata.resourceVersion,
      })
      if (conflict) return { code: 1, stdout: '', stderr: 'Conflict' }
      lock = {
        metadata: { resourceVersion: String(++version) },
        data: { holder: patches[1]?.value ?? '', renewedAt: patches[2]?.value ?? '' },
      }
    }
    return { code: 0, stdout, stderr: '' }
  })
  const sandboxes = {
    list: vi.fn(async () => structuredClone(records)),
    sleep: vi.fn(() => ({ operationId: 'sleep' })),
    expire: vi.fn(() => ({ operationId: 'expire' })),
  }
  const operations = {
    active: vi.fn((_repo: string, _workload: string): Operation | undefined => undefined),
  }
  const timers = { setInterval: vi.fn(setInterval), clearInterval: vi.fn(clearInterval) }
  const controller = new SandboxController({
    sandboxes,
    operations,
    kubectl,
    instanceId: 'one',
    namespace: async () => namespace,
    now: Date.now,
    timers,
  })
  return {
    controller,
    sandboxes,
    operations,
    kubectl,
    timers,
    lock: () => lock,
    setLock: (holder: string, renewedAt: number) => {
      lock = {
        metadata: { resourceVersion: String(++version) },
        data: { holder, renewedAt: String(renewedAt) },
      }
    },
    conflict: () => {
      conflict = true
    },
    namespace: (value: string) => {
      namespace = value
    },
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-19T00:00:00Z'))
  vi.stubEnv('DEVDOCK_CONTROLLER', 'auto')
  vi.stubEnv('DEVDOCK_SANDBOX_TTL_HOURS', '24')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

describe('controller leadership', () => {
  it('creates and renews the personal namespace lock with CAS every 30s', async () => {
    const f = fixture()
    await f.controller.start()
    expect(f.controller.status()).toEqual({
      holder: 'one',
      isLeader: true,
      lastPollAt: Date.now(),
      lastError: null,
    })
    expect(f.kubectl.mock.calls[0]?.[1]).toContain('personal')
    const first = f.lock()?.data.renewedAt
    await advance(30_000)
    expect(f.lock()?.data.renewedAt).not.toBe(first)
    expect(f.kubectl.mock.calls.filter(([, args]) => args[0] === 'patch')).toHaveLength(1)
    f.controller.stop()
    await advance(minute)
    expect(f.controller.status().isLeader).toBe(false)
    expect(f.timers.clearInterval).toHaveBeenCalledOnce()
  })
  it('waits past 90s before taking another holder over', async () => {
    const f = fixture()
    f.setLock('two', Date.now())
    await f.controller.start()
    expect(f.controller.status().holder).toBe('two')
    expect(f.sandboxes.list).not.toHaveBeenCalled()
    await advance(90_000)
    expect(f.controller.status().isLeader).toBe(false)
    await advance(30_000)
    expect(f.controller.status().isLeader).toBe(true)
  })
  it('loses leadership on CAS conflict and performs no actions', async () => {
    const f = fixture()
    await f.controller.start()
    f.conflict()
    await advance(minute)
    expect(f.controller.status()).toMatchObject({ isLeader: false, lastError: 'Conflict' })
    expect(f.sandboxes.list).toHaveBeenCalledOnce()
  })
  it('never acquires or starts timers when disabled', async () => {
    vi.stubEnv('DEVDOCK_CONTROLLER', 'off')
    const f = fixture()
    await f.controller.start()
    await advance(10 * minute)
    expect(f.kubectl).not.toHaveBeenCalled()
    expect(f.timers.setInterval).not.toHaveBeenCalled()
    expect(f.controller.status().isLeader).toBe(false)
  })
  it('does not act when stopped during an in-flight lock read', async () => {
    const f = fixture()
    let release: ((result: { code: number; stdout: string; stderr: string }) => void) | undefined
    f.kubectl.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const starting = f.controller.start()
    await Promise.resolve()
    f.controller.stop()
    release?.({ code: 0, stdout: '', stderr: '' })
    await starting
    expect(f.kubectl).toHaveBeenCalledOnce()
    expect(f.sandboxes.list).not.toHaveBeenCalled()
  })
  it('changes leadership namespace when the context moves', async () => {
    const f = fixture()
    await f.controller.start()
    f.namespace('other')
    f.setLock('two', Date.now())
    await advance(30_000)
    expect(f.controller.status().isLeader).toBe(false)
    expect(f.kubectl.mock.calls.at(-1)?.[1]).toContain('other')
  })
})

describe('controller scheduling', () => {
  it('sleeps idle awake sandboxes and expires on the hourly sweep without deleting', async () => {
    const record = sandbox({ lastUsedAt: Date.now() - 31 * minute })
    const f = fixture([record])
    await f.controller.start()
    expect(f.sandboxes.sleep).toHaveBeenCalledWith('ticket', 'controller')
    record.power = 'asleep'
    record.lastUsedAt = Date.now() - 24 * 60 * minute
    await advance(60 * minute - 1)
    expect(f.sandboxes.expire).not.toHaveBeenCalled()
    await advance(1)
    expect(f.sandboxes.expire).toHaveBeenCalledWith('ticket', 'controller')
  })
  it('leaves recently used and asleep sandboxes alone', async () => {
    const f = fixture([
      sandbox({ key: 'fresh', lastUsedAt: Date.now() - 29 * minute }),
      sandbox({ key: 'asleep', power: 'asleep', lastUsedAt: Date.now() - 31 * minute }),
    ])
    await f.controller.start()
    await advance(minute)
    expect(f.sandboxes.sleep).not.toHaveBeenCalled()
    expect(f.sandboxes.expire).not.toHaveBeenCalled()
    expect(f.controller.status().lastPollAt).toBe(Date.now())
  })
  it('prioritizes expiry over sleep and skips personal, unallocated and busy records', async () => {
    const expired = { lastUsedAt: Date.now() - 25 * 60 * minute }
    const f = fixture([
      sandbox({ key: 'personal', personal: true, ...expired }),
      sandbox({ key: 'gone', slot: undefined, ...expired }),
      sandbox({ key: 'busy', ...expired }),
      sandbox(expired),
    ])
    f.operations.active.mockImplementation((key) =>
      key === 'sandbox:busy' ? ({ id: 'active' } as Operation) : undefined,
    )
    await f.controller.start()
    expect(f.sandboxes.expire.mock.calls).toEqual([['ticket', 'controller']])
    expect(f.sandboxes.sleep).not.toHaveBeenCalled()
  })
  it('contains a failed action and continues other sandboxes', async () => {
    const idle = { lastUsedAt: Date.now() - 31 * minute }
    const f = fixture([sandbox(idle), sandbox({ key: 'other', ...idle })])
    f.sandboxes.sleep.mockImplementationOnce(() => {
      throw new Error('already active')
    })
    await f.controller.start()
    expect(f.controller.status().lastError).toBe('already active')
    expect(f.sandboxes.sleep).toHaveBeenCalledTimes(2)
  })
})
