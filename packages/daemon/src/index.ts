// @devdock/daemon — the only brain. Composes the core Service with HTTP + WS.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AwsCreds,
  Service,
  checkTools,
  missingToolWarnings,
  pathShadowWarnings,
} from '@devdock/core'
import { AccessGate } from './accessGate.js'
import { listenAgent } from './agentAccess.js'
import { Instances } from './instances.js'
import { listen } from './listener.js'
import { mountMcp } from './mcp.js'
import { buildApp } from './routes.js'
import { attachWs } from './wsServer.js'

const PORT = Number(process.env.DEVDOCK_PORT ?? 7717)
const HOST = process.env.DEVDOCK_HOST ?? '127.0.0.1'
const SOCKET = process.env.DEVDOCK_SOCKET || undefined

function installedBuild() {
  try {
    const [sha, builtAt, repoPath] = readFileSync(
      new URL('../../../build-info', import.meta.url),
      'utf8',
    ).split('\n')
    if (sha && builtAt && repoPath) return { sha, builtAt, repoPath }
  } catch {
    // An installed release has its own metadata. Source runs use the checkout.
  }
  const root = new URL('../../../', import.meta.url)
  if (!existsSync(new URL('pnpm-workspace.yaml', root))) return
  const repoPath = fileURLToPath(root)
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim()
    const builtAt = statSync(new URL(import.meta.url)).mtime.toISOString()
    return { sha, builtAt, repoPath }
  } catch {
    return undefined
  }
}

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
  // Outgoing links must not expose this daemon through a reverse SSH tunnel.
  const instances = new Instances(join(homedir(), '.devdock'))
  const service = new Service(
    {
      roots,
      stateFile: join(homedir(), '.devdock', 'state.json'),
      instanceId: instances.identity.id,
      daemonBuild: installedBuild(),
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
  // Only the main listener serves MCP; the agent socket keeps its route allowlist.
  const closeMcp = mountMcp(app)
  const address = await listen(app, { port: PORT, host: HOST, socket: SOCKET })
  const agentApp = process.env.DEVDOCK_AGENT_SOCKET
    ? await listenAgent(service, process.env.DEVDOCK_AGENT_SOCKET)
    : undefined
  const streams = attachWs(app.server, service, gate, instances)
  instances.start()

  await service.startLoop()
  console.log(`devdock daemon listening on ${address}, roots: ${roots.join(', ')}`)

  const shutdown = () => {
    instances.close()
    service.stopLoop()
    for (const client of streams.clients) client.terminate()
    streams.close()
    void Promise.all([closeMcp(), app.close(), agentApp?.close()]).then(() => process.exit(0))
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
