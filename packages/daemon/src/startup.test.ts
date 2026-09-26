import { describe, expect, it } from 'vitest'
import type { CallResult, InstanceCall } from './move.js'
import { copyStartupCommands } from './startup.js'

type Machines = Record<string, Record<string, Record<string, string>>>

/** Machines answering `/repos` and the startup PUT like a daemon. */
function fleet(machines: Machines, podTypes: Record<string, string[]> = {}) {
  const puts: string[] = []
  const call: InstanceCall = async (instance, method, path, body): Promise<CallResult> => {
    const repos = machines[instance]
    if (!repos) throw new Error('unknown instance link')
    if (method === 'GET' && path === '/repos')
      return {
        status: 200,
        body: Object.entries(repos).map(([id, startupCommands]) => ({
          repo: { id },
          startupCommands,
        })),
      }
    const put = method === 'PUT' ? /^\/repos\/([^/]+)\/startup$/.exec(path) : null
    if (put?.[1]) {
      const { command, workload } = body as { command: string; workload: string }
      if (podTypes[put[1]] && !podTypes[put[1]]?.includes(workload))
        return { status: 500, body: { error: 'unknown startup pod type' } }
      puts.push(`${instance} ${put[1]} ${workload}`)
      const commands = repos[put[1]] ?? {}
      commands[workload] = command
      repos[put[1]] = commands
      return { status: 200, body: { ok: true } }
    }
    return { status: 404, body: { error: 'not found' } }
  }
  return { call, puts }
}

describe('copying startup commands', () => {
  it('fills only the gaps on the receiving machine', async () => {
    const machines: Machines = {
      mac: { api: { api: 'php artisan serve' }, ui: { ui: 'npm start' }, only: { api: 'x' } },
      box: { api: {}, ui: { ui: 'yarn dev' } },
    }
    const f = fleet(machines)
    const copied = await copyStartupCommands(f.call, 'mac', 'box')
    expect(copied).toEqual([{ repo: 'api', podType: 'api' }])
    expect(machines.box).toEqual({ api: { api: 'php artisan serve' }, ui: { ui: 'yarn dev' } })
  })

  it('copies one repo when asked and skips pod types the target does not offer', async () => {
    const machines: Machines = {
      mac: { api: { api: 'serve', worker: 'work' }, ui: { ui: 'npm start' } },
      box: { api: {}, ui: {} },
    }
    const f = fleet(machines, { api: ['api'] })
    const copied = await copyStartupCommands(f.call, 'mac', 'box', 'api')
    expect(copied).toEqual([{ repo: 'api', podType: 'api' }])
    expect(f.puts).toEqual(['box api api'])
  })
})
