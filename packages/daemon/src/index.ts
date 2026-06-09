// @devdock/daemon — the only brain. Fastify (HTTP) + ws + MCP entry,
// all thin callers of @devdock/core. Routes land in Phase 1.
import { version } from '@devdock/core'

function main() {
  console.log(`devdock daemon — core v${version} — scaffold, no routes yet`)
}

main()
