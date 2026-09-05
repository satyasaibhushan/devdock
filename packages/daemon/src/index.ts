// @devdock/daemon — the only brain. Composes the core Service with HTTP + WS.
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  AwsCreds,
  Service,
  checkTools,
  missingToolWarnings,
  pathShadowWarnings,
} from '@devdock/core'
import { AccessGate } from './accessGate.js'
import { Instances } from './instances.js'
import { listen } from './listener.js'
import { buildApp } from './routes.js'
import { attachWs } from './wsServer.js'

const PORT = Number(process.env.DEVDOCK_PORT ?? 7717)
const HOST = process.env.DEVDOCK_HOST ?? '127.0.0.1'
const SOCKET = process.env.DEVDOCK_SOCKET || undefined

async function main() {
  for (const w of missingToolWarnings(await checkTools())) {
    console.warn(`devdock: ${w}`)
  }
  // Slow-tools check runs in the background — boot shouldn't wait on a login shell.
  void pathShadowWarnings()
    .then((ws) => {
      for (const w of ws) console.warn(`devdock: ${w}`)
    })
    .catch(() => undefined)

  const roots = (process.env.DEVDOCK_ROOTS ?? join(homedir(), 'Code')).split(':').filter(Boolean)
  const instances = new Instances(
    join(homedir(), '.devdock'),
    undefined,
    SOCKET ?? `127.0.0.1:${PORT}`,
  )
  const service = new Service(
    {
      roots,
      stateFile: join(homedir(), '.devdock', 'state.json'),
      instanceId: instances.identity.id,
    },
    process.env.DEVDOCK_AWS_AUTH === 'external'
      ? { awsCreds: new AwsCreds({ oidcConfigPath: null }) }
      : {},
  )

  const gate = AccessGate.load(
    process.env.DEVDOCK_CONTROL_TOKEN_FILE ?? join(homedir(), '.devdock', 'control-token'),
    Boolean(SOCKET),
  )
  const app = buildApp(service, gate, instances)
  const address = await listen(app, { port: PORT, host: HOST, socket: SOCKET })
  const streams = attachWs(app.server, service, gate, instances)
  instances.start()

  await service.startLoop()
  console.log(`devdock daemon listening on ${address}, roots: ${roots.join(', ')}`)

  const shutdown = () => {
    instances.close()
    service.stopLoop()
    for (const client of streams.clients) client.terminate()
    streams.close()
    void app.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    // Single-instance guard: the port is the lock. A second daemon (launchd
    // respawn racing a manual run, or vice versa) must not fight the first.
    console.error(
      `devdock daemon already listening on ${HOST}:${PORT} — refusing to start a second instance`,
    )
    process.exit(0)
  }
  console.error('devdock daemon failed to start:', err)
  process.exit(1)
})
