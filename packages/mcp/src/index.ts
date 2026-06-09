// @devdock/mcp — the second entry point over the one brain. Speaks MCP on stdio,
// calls the daemon's HTTP API. Scope (ro|rw) gates the write verbs.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { httpClient } from './client.js'
import { createServer } from './server.js'
import type { Scope } from './tools.js'

async function main() {
  const baseUrl = process.env.DEVDOCK_DAEMON ?? 'http://127.0.0.1:7717'
  const scope: Scope = process.env.DEVDOCK_MCP_SCOPE === 'rw' ? 'rw' : 'ro'

  const server = createServer(httpClient(baseUrl), scope)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`devdock MCP ready — scope=${scope}, daemon=${baseUrl}`)
}

main().catch((err) => {
  console.error('devdock MCP failed to start:', err)
  process.exit(1)
})
