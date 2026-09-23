// Wire devdock's tools into an MCP server (spec §14). Transport-agnostic: the
// caller serves stdio (index.ts) or HTTP (mcpHttpHandler, mounted by the daemon).
import { type McpHttpHandler, McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { DaemonClient } from './client.js'
import { type Scope, toolsForScope } from './tools.js'

// The tool set only changes with a new release, and a release restarts the
// daemon, so clients may reuse tools/list for a while instead of re-listing.
const TOOLS_LIST_TTL_MS = 5 * 60_000

export function createServer(client: DaemonClient, scope: Scope): McpServer {
  const server = new McpServer(
    { name: 'devdock', version: '0.0.0' },
    { cacheHints: { 'tools/list': { ttlMs: TOOLS_LIST_TTL_MS, cacheScope: 'private' } } },
  )

  for (const tool of toolsForScope(client, scope)) {
    if (
      process.env.DEVDOCK_MCP_DEVELOPMENT_ONLY === '1' &&
      /^devdock_(term_|instance)/.test(tool.name)
    )
      continue
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: z.object(tool.inputSchema) },
      async (args: Record<string, unknown>) => {
        try {
          return { content: [{ type: 'text', text: await tool.handler(args) }] }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return { isError: true, content: [{ type: 'text', text: message }] }
        }
      },
    )
  }

  return server
}

/** Serves both protocol eras over HTTP, one fresh server per request.
 *  Always SSE: long tools (term_run, wait) would otherwise send no bytes until
 *  they finish, and HTTP clients give up waiting for response headers. */
export function mcpHttpHandler(client: DaemonClient, scope: Scope): McpHttpHandler {
  return createMcpHandler(() => createServer(client, scope), { responseMode: 'sse' })
}
