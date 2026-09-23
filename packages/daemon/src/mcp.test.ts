import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RunResult, Service } from '@devdock/core'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AccessGate } from './accessGate.js'
import { buildAgentApp } from './agentAccess.js'
import { mountMcp } from './mcp.js'
import { buildApp } from './routes.js'

let root: string
let app: FastifyInstance | undefined
let closeMcp: (() => Promise<void>) | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devdock-mcp-'))
  mkdirSync(join(root, 'svc-a'), { recursive: true })
  writeFileSync(join(root, 'svc-a', 'devspace.yaml'), 'name: svc-a\nnamespace: ns\n')
})
afterEach(async () => {
  await closeMcp?.()
  await app?.close()
  app = undefined
  closeMcp = undefined
  rmSync(root, { recursive: true, force: true })
})

function makeService(): Service {
  const runner = async (cmd: string, args: string[]): Promise<RunResult> => {
    if (cmd === 'tmux' && args[0] === 'has-session') return { code: 1, stdout: '', stderr: '' }
    if (cmd === 'kubectl' && args[0] === 'config')
      return { code: 0, stdout: args[1] === 'view' ? 'testns' : '', stderr: '' }
    if (cmd === 'kubectl') return { code: 0, stdout: '{"items":[]}', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const svc = new Service({ roots: [root], stateFile: join(root, 'state.json') }, { runner })
  svc.rescan()
  return svc
}

async function serve(): Promise<string> {
  const svc = makeService()
  await svc.reconcileAll()
  app = buildApp(svc, new AccessGate('secret'))
  closeMcp = mountMcp(app)
  await app.listen({ host: '127.0.0.1', port: 0 })
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
}

async function connect(url: string, modern: boolean): Promise<Client> {
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  )
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  const [first] = result.content as Array<{ type: string; text?: string }>
  return first?.text ?? ''
}

describe('daemon MCP endpoint', () => {
  for (const modern of [true, false]) {
    it(`serves ${modern ? '2026-07-28' : '2025-era'} clients through the daemon routes`, async () => {
      const base = await serve()
      const client = await connect(`${base}/mcp`, modern)
      try {
        expect(client.getProtocolEra()).toBe(modern ? 'modern' : 'legacy')
        const { tools } = await client.listTools()
        expect(tools.map((t) => t.name)).toContain('devdock_list')
        expect(tools.map((t) => t.name)).not.toContain('devdock_start')
        const listed = await client.callTool({ name: 'devdock_list', arguments: {} })
        expect(listed.isError).toBeFalsy()
        expect(text(listed)).toContain('svc-a')
        const missing = await client.callTool({
          name: 'devdock_status',
          arguments: { repo: 'nope' },
        })
        expect(missing.isError).toBe(true)
      } finally {
        await client.close()
      }
    })
  }

  it('exposes write verbs only on /mcp/rw', async () => {
    const base = await serve()
    const client = await connect(`${base}/mcp/rw`, true)
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(['devdock_list', 'devdock_start', 'devdock_exec']),
      )
    } finally {
      await client.close()
    }
  })

  it('applies the ingress gate to MCP requests', async () => {
    const base = await serve()
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        origin: 'https://evil.example',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(403)
  })

  it('is not reachable through the development socket app', async () => {
    const agent = buildAgentApp(makeService())
    try {
      const res = await agent.inject({ method: 'POST', url: '/mcp', payload: {} })
      expect(res.statusCode).toBe(403)
    } finally {
      await agent.close()
    }
  })
})
