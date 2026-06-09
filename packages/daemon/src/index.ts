// @devdock/daemon — the only brain. Composes the core Service with HTTP + WS.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Service } from '@devdock/core'
import { buildApp } from './routes.js'
import { attachWs } from './wsServer.js'

const PORT = Number(process.env.DEVDOCK_PORT ?? 7717)
const HOST = process.env.DEVDOCK_HOST ?? '127.0.0.1'

async function main() {
  const roots = (process.env.DEVDOCK_ROOTS ?? join(homedir(), 'Code')).split(':').filter(Boolean)
  const service = new Service({
    roots,
    stateFile: join(homedir(), '.devdock', 'state.json'),
  })

  const app = buildApp(service)
  await app.listen({ port: PORT, host: HOST })
  attachWs(app.server, service)

  await service.startLoop()
  console.log(`devdock daemon listening on http://${HOST}:${PORT} — roots: ${roots.join(', ')}`)

  const shutdown = () => {
    service.stopLoop()
    void app.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('devdock daemon failed to start:', err)
  process.exit(1)
})
