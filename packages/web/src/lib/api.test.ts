import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachTerminal, createTerminal, openLogs, runVerb } from './api'

afterEach(() => vi.unstubAllGlobals())
describe('explicit instance routing', () => {
  it('keeps actions and terminal creation on their captured instance', async () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ ok: true }),
    }))
    vi.stubGlobal('fetch', fetch)
    await runVerb('accounts', 'start', 'api', 'box')
    await createTerminal({ repo: 'accounts', workload: 'api' }, 'box')
    await runVerb('accounts', 'build', 'api', '')
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      '/instances/box/api/repos/accounts/start?workload=api',
      '/instances/box/api/terminals',
      '/repos/accounts/build?workload=api',
    ])
  })
  it('routes log and terminal sockets through the same owner', () => {
    const urls: string[] = []
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:7717' })
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor(url: string) {
          urls.push(url)
        }
      },
    )
    openLogs('accounts', 'api', 'box')
    attachTerminal('t1', 'ro', 80, 24, true, 'box')
    expect(urls).toEqual([
      'ws://localhost:7717/instances/box/api/repos/accounts/logs?workload=api',
      'ws://localhost:7717/instances/box/api/terminals/t1/attach?mode=ro&cols=80&rows=24',
    ])
  })
})
