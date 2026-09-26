import { describe, expect, it } from 'vitest'
import { type CallResult, type InstanceCall, moveDeployment, planMove } from './move.js'

const MAC = '11111111-1111-1111-1111-111111111111'
const BOX = '22222222-2222-2222-2222-222222222222'

interface Machine {
  hasSession: boolean
  commit: string
  branch?: string
  startup?: string
}

/** Two machines sharing one claim, each answering like a daemon's API. */
function fleet(machines: Record<string, Machine | undefined>, owner: string | undefined) {
  const calls: string[] = []
  let claim = owner
  const call: InstanceCall = async (instance, method, path, body): Promise<CallResult> => {
    const machine = machines[instance]
    if (!machine) throw new Error('unknown instance link')
    calls.push(
      `${instance === MAC ? 'mac' : 'box'} ${method} ${path}${body ? ` ${JSON.stringify(body)}` : ''}`,
    )
    if (path === '/repos')
      return {
        status: 200,
        body: [
          {
            repo: { id: 'api', defaultWorkload: 'api' },
            startupCommands: machine.startup ? { api: machine.startup } : {},
            workloads: [
              {
                type: 'api',
                hasSession: machine.hasSession,
                ownershipKnown: true,
                ownerInstanceId: claim,
              },
            ],
          },
        ],
      }
    if (path.startsWith('/repos/api/checkout'))
      return {
        status: 200,
        body: { branch: machine.branch ?? 'main', commit: machine.commit, dirty: false },
      }
    if (path.startsWith('/repos/api/release')) {
      if (claim !== instance) return { status: 409, body: { error: 'not ours' } }
      claim = undefined
      return { status: 200, body: { ok: true } }
    }
    if (path.startsWith('/repos/api/take-over')) {
      claim = instance
      return { status: 200, body: { ok: true } }
    }
    if (path === '/repos/api/startup' && method === 'PUT') {
      machine.startup = (body as { command: string }).command
      return { status: 200, body: { ok: true } }
    }
    if (path === '/repos/api/operations') return { status: 202, body: { id: 'op1' } }
    return { status: 404, body: { error: 'not found' } }
  }
  return { call, calls, claim: () => claim }
}

describe('moving a deployment', () => {
  it('carries a live session over and rebuilds when the target is at another commit', async () => {
    const f = fleet(
      {
        [MAC]: { hasSession: true, commit: 'aaa', startup: 'php artisan serve' },
        [BOX]: { hasSession: false, commit: 'bbb', branch: 'feature' },
      },
      MAC,
    )
    const plan = await planMove(f.call, 'api', undefined, BOX)
    expect(plan).toMatchObject({
      owner: MAC,
      ownerOnline: true,
      live: true,
      sameRevision: false,
      followUp: 'build_start',
    })
    expect(plan.from?.commit).toBe('aaa')
    expect(plan.target.branch).toBe('feature')

    const result = await moveDeployment(f.call, 'api', undefined, BOX)
    expect(result.claim).toBe('released')
    expect(result.startupCopied).toEqual([{ repo: 'api', podType: 'api' }])
    // The startup command lands before the start that queues it.
    expect(f.calls.filter((c) => !c.includes('GET'))).toEqual([
      'mac POST /repos/api/release',
      'box PUT /repos/api/startup {"command":"php artisan serve","workload":"api"}',
      'box POST /repos/api/operations {"action":"build_start"}',
    ])
  })

  it('restarts without a rebuild when both checkouts are at the same commit', async () => {
    const f = fleet(
      { [MAC]: { hasSession: true, commit: 'aaa' }, [BOX]: { hasSession: false, commit: 'aaa' } },
      MAC,
    )
    expect((await planMove(f.call, 'api', undefined, BOX)).followUp).toBe('start')
  })

  it('takes the claim over from an unreachable owner and starts nothing unless asked', async () => {
    const f = fleet({ [BOX]: { hasSession: false, commit: 'bbb' } }, MAC)
    const result = await moveDeployment(f.call, 'api', undefined, BOX)
    expect(result).toMatchObject({
      claim: 'taken_over',
      plan: { ownerOnline: false, followUp: 'none' },
    })
    expect(f.claim()).toBe(BOX)
    expect(f.calls.filter((c) => c.includes('POST'))).toEqual([
      `box POST /repos/api/take-over {"from":"${MAC}"}`,
    ])
  })

  it('refuses to move onto the machine that already owns it', async () => {
    const f = fleet(
      { [MAC]: { hasSession: true, commit: 'aaa' }, [BOX]: { hasSession: false, commit: 'aaa' } },
      BOX,
    )
    await expect(planMove(f.call, 'api', undefined, BOX)).rejects.toThrow('already on that machine')
  })

  it('stops before starting when the owner will not release', async () => {
    const f = fleet(
      { [MAC]: { hasSession: true, commit: 'aaa' }, [BOX]: { hasSession: false, commit: 'aaa' } },
      MAC,
    )
    const call: InstanceCall = (instance, method, path, body) =>
      path.includes('/release')
        ? Promise.resolve({ status: 409, body: { error: 'operation in progress' } })
        : f.call(instance, method, path, body)
    await expect(moveDeployment(call, 'api', undefined, BOX)).rejects.toThrow(
      'operation in progress',
    )
    expect(f.calls.some((c) => c.includes('/operations'))).toBe(false)
  })
})
