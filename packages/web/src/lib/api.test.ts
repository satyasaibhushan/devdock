import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachTerminal,
  buildSandbox,
  createSandbox,
  createTerminal,
  discoverSandbox,
  fetchSandboxController,
  fetchSandboxLogs,
  fetchSandboxes,
  openLogs,
  runVerb,
  sandboxAction,
  updateSandbox,
} from './api'

afterEach(() => vi.unstubAllGlobals())
describe('explicit instance routing', () => {
  it('opens normal terminals on the chosen machine without dropping repo scope', async () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ id: 'accounts:t2' }),
    }))
    vi.stubGlobal('fetch', fetch)
    await createTerminal({ repo: 'accounts', workload: 'api', kind: 'local' }, 'box')
    expect(fetch.mock.calls[0]?.[0]).toBe('/instances/box/api/terminals')
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      repo: 'accounts',
      workload: 'api',
      kind: 'local',
    })
  })
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

describe('sandbox client', () => {
  const okFetch = (body: unknown) =>
    vi.fn(async (_path: string, _init?: RequestInit) => ({ ok: true, json: async () => body }))
  it('routes reads through the chosen instance', async () => {
    const fetch = okFetch([])
    vi.stubGlobal('fetch', fetch)
    await fetchSandboxes('box')
    await fetchSandboxController('box')
    await discoverSandbox('SULF-1', '')
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      '/instances/box/api/sandboxes',
      '/instances/box/api/sandboxes/controller',
      '/sandboxes/SULF-1/discover',
    ])
  })
  it('signs every mutation as the ui actor with the right method and path', async () => {
    const fetch = okFetch({ operationId: 'op1' })
    vi.stubGlobal('fetch', fetch)
    const pr = {
      kind: 'pr' as const,
      repoSlug: 'v/r',
      number: 1,
      url: 'https://github.com/v/r/pull/1',
    }
    await createSandbox(
      { key: 'SULF-1', members: [{ repo: 'r', workload: 'api', source: pr }] },
      '',
    )
    await updateSandbox('SULF-1', { remove: [{ repo: 'r', workload: 'api' }] }, '')
    await buildSandbox('SULF-1', { repo: 'r' }, 'box')
    await sandboxAction('SULF-1', 'wake', '')
    await sandboxAction('a/b', 'delete', '')
    const calls = fetch.mock.calls.map(([path, init]) => [
      init?.method,
      path,
      JSON.parse(String(init?.body)).actor,
    ])
    expect(calls).toEqual([
      ['POST', '/sandboxes', 'ui'],
      ['PATCH', '/sandboxes/SULF-1', 'ui'],
      ['POST', '/instances/box/api/sandboxes/SULF-1/build', 'ui'],
      ['POST', '/sandboxes/SULF-1/wake', 'ui'],
      ['DELETE', '/sandboxes/a%2Fb', 'ui'],
    ])
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({ repo: 'r', actor: 'ui' })
  })
  it('surfaces the daemon error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: 'Sandbox namespace pool full' }),
      })),
    )
    await expect(sandboxAction('SULF-1', 'sleep', '')).rejects.toThrow(
      'Sandbox namespace pool full',
    )
  })
  it('reads log tails first and cursors afterwards', async () => {
    const fetch = okFetch({ lines: [], cursor: 'c1' })
    vi.stubGlobal('fetch', fetch)
    const member = { repo: 'acs-org', workload: 'api' }
    await fetchSandboxLogs('SULF-1', member, '')
    await fetchSandboxLogs('SULF-1', member, 'box', 'c1')
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      '/repos/acs-org/logs/query?sandbox=SULF-1&workload=api&source=container&tail=200',
      '/instances/box/api/repos/acs-org/logs/query?sandbox=SULF-1&workload=api&source=container&cursor=c1',
    ])
  })
})
