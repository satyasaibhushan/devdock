import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import type { FastifyInstance } from 'fastify'

export async function listen(
  app: FastifyInstance,
  options: { socket?: string; host: string; port: number },
): Promise<string> {
  if (!options.socket) return app.listen({ host: options.host, port: options.port })
  if (!isAbsolute(options.socket)) throw new Error('DEVDOCK_SOCKET must be an absolute path')

  const directory = dirname(options.socket)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('DEVDOCK_SOCKET requires a private directory owned by the daemon user')
  }
  // The private parent prevents access before socket permissions are applied.
  const address = await app.listen({ path: options.socket })
  chmodSync(options.socket, 0o600)
  return address
}
