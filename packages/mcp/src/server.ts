// Wire devdock's tools into an MCP server (spec §14). Transport-agnostic: the
// caller connects stdio (index.ts) or any other MCP transport.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { DaemonClient } from './client.js'
import { type Scope, toolsForScope } from './tools.js'

export function createServer(client: DaemonClient, scope: Scope): McpServer {
  const server = new McpServer({ name: 'devdock', version: '0.0.0' })

  for (const tool of toolsForScope(client, scope)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
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
