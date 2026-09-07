import { chmodSync, lstatSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import type { Service } from '@devdock/core'
import { peerPathAllowed } from './instances.js'
import { buildApp } from './routes.js'

/** Development operations share the daemon; host shells and peer routing do not. */
export function buildAgentApp(service: Service) {
  const app = buildApp(service)
  app.addHook('onRequest', async (req, reply) => {
    if (!peerPathAllowed(req.url, false)) {
      return reply.code(403).send({ error: 'Operation unavailable on the development socket' })
    }
  })
  return app
}

export async function listenAgent(service: Service, socket: string) {
  if (!isAbsolute(socket)) throw new Error('Development socket must be absolute')
  const directory = lstatSync(dirname(socket))
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o027) !== 0 ||
    (directory.mode & 0o2000) === 0
  ) {
    throw new Error(
      'Development socket requires a daemon-owned, setgid directory without group write or other access',
    )
  }
  const app = buildAgentApp(service)
  await app.listen({ path: socket })
  chmodSync(socket, 0o660)
  return app
}
