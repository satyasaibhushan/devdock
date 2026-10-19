import { readFileSync } from 'node:fs'
import { Service } from '@devdock/core'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { daemonClient } from './client.js'
import { sandboxMethods } from './sandboxTools.js'
import { allTools, toolsForScope } from './tools.js'

const client = daemonClient(async () => new Response('{}'))

it('keeps every public sandbox service method and MCP tool in parity', () => {
  // TypeScript private methods survive on the JS prototype; inspect declarations for visibility.
  const source = readFileSync(new URL('../../core/src/service.ts', import.meta.url), 'utf8')
  const methods = [...source.matchAll(/^ {2}(?:async )?(\w*(?:[Ss]andbox\w*|recordHead))\(/gm)].map(
    (m) => m[1],
  )
  expect(methods.sort()).toEqual(Object.keys(sandboxMethods).sort())
  for (const method of Object.keys(sandboxMethods))
    expect(Object.hasOwn(Service.prototype, method)).toBe(true)
  const tools = allTools(client).filter((t) => t.name.startsWith('devdock_sandbox_'))
  expect(tools.map((t) => t.name).sort()).toEqual(
    Object.values(sandboxMethods)
      .map((s) => `devdock_sandbox_${s}`)
      .sort(),
  )
})

describe('sandbox MCP', () => {
  it('reads controller status through its static HTTP route', async () => {
    const send = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ holder: 'one', isLeader: true, lastPollAt: 123, lastError: null }),
        ),
    )
    const tool = allTools(daemonClient(send)).find((t) => t.name === 'devdock_sandbox_controller')
    expect(tool?.scope).toBe('ro')
    expect(JSON.parse((await tool?.handler({})) as string)).toMatchObject({
      holder: 'one',
      isLeader: true,
    })
    expect(send).toHaveBeenCalledWith('/sandboxes/controller', undefined)
  })
  it('exposes reads at ro and requires a nonblank actor for every mutation', async () => {
    const ro = toolsForScope(client, 'ro').filter((t) => t.name.startsWith('devdock_sandbox_'))
    expect(ro.map((t) => t.name).sort()).toEqual([
      'devdock_sandbox_controller',
      'devdock_sandbox_discover',
      'devdock_sandbox_list',
      'devdock_sandbox_status',
    ])
    for (const t of allTools(client).filter(
      (t) => t.name.startsWith('devdock_sandbox_') && t.scope === 'rw',
    )) {
      expect(
        z
          .object(t.inputSchema)
          .safeParse({ key: 'SULF-1', repo: 'app', workload: 'api', sha: 'abc', actor: ' ' })
          .success,
      ).toBe(false)
      await expect(t.handler({ key: 'SULF-1' })).rejects.toThrow()
    }
  })
  it('routes all sandbox calls through HTTP, preserving actor and encoded key', async () => {
    const send = vi.fn(async () => new Response(JSON.stringify({ operationId: 'op1' })))
    const tools = allTools(daemonClient(send))
    for (const suffix of [
      'create',
      'update',
      'build',
      'snapshot',
      'wake',
      'sleep',
      'expire',
      'delete',
      'head',
    ]) {
      const t = tools.find((t) => t.name === `devdock_sandbox_${suffix}`)
      await t?.handler({
        key: 'SULF/1',
        repo: 'app',
        workload: 'api',
        sha: 'a'.repeat(40),
        actor: 'agent:test',
      })
      const [path, init] = send.mock.calls.at(-1) as unknown as [string, RequestInit]
      expect(path).toContain(suffix === 'create' ? '/sandboxes' : '/sandboxes/SULF%2F1')
      expect(JSON.parse(init.body as string).actor).toBe('agent:test')
      expect(init.method).toBe(
        suffix === 'update' ? 'PATCH' : suffix === 'delete' ? 'DELETE' : 'POST',
      )
    }
  })
  it('passes optional sandbox to logs and exec', async () => {
    const send = vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path.includes('logs')
              ? { source: 'container', lines: [], cursor: 'c' }
              : { ok: true, code: 0 },
          ),
        ),
    )
    const tools = allTools(daemonClient(send))
    await tools.find((t) => t.name === 'devdock_logs')?.handler({ repo: 'app', sandbox: 'SULF-1' })
    expect(send.mock.calls[0]?.[0]).toContain('sandbox=SULF-1')
    await tools
      .find((t) => t.name === 'devdock_exec')
      ?.handler({ repo: 'app', sandbox: 'SULF-1', actor: 'you', command: 'pwd' })
    expect(send.mock.calls[1]?.[0]).toContain('sandbox=SULF-1')
  })
})
