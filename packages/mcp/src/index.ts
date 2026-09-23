// @devdock/mcp — the second entry point over the one brain. Speaks MCP on stdio,
// calls the daemon's HTTP API. Scope (ro|rw) gates the write verbs.
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { httpClient } from './client.js'
import { createServer } from './server.js'
import type { Scope } from './tools.js'

async function main() {
  const baseUrl = process.env.DEVDOCK_DAEMON ?? 'http://127.0.0.1:7717'
  const scope: Scope = process.env.DEVDOCK_MCP_SCOPE === 'rw' ? 'rw' : 'ro'

  const client = httpClient(baseUrl)
  serveStdio(() => createServer(client, scope), {
    onerror: (err) => console.error('devdock MCP transport error:', err),
  })
  console.error(`devdock MCP ready — scope=${scope}, daemon=${baseUrl}`)
}

main().catch((err) => {
  console.error('devdock MCP failed to start:', err)
  process.exit(1)
})
