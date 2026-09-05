import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { AccessGate } from './accessGate.js'
import { listen } from './listener.js'

const apps: FastifyInstance[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dd-'))
  directories.push(directory)
  const app = Fastify()
  apps.push(app)
  return { app, directory, socket: join(directory, 'control.sock') }
}

describe('private listener', () => {
  it('serves owner requests on a private socket without a TCP listener', async () => {
    const { app, socket } = fixture()
    const gate = new AccessGate('secret', true)
    app.get('/health', async (req, reply) => {
      if (!gate.authorize({ remoteAddress: req.ip })) return reply.code(403).send()
      return { ok: true }
    })
    await listen(app, { socket, host: '127.0.0.1', port: 0 })
    expect(app.server.address()).toBe(socket)
    expect(statSync(socket).mode & 0o777).toBe(0o600)
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ socketPath: socket, path: '/health' }, (response) => {
        response.resume()
        resolve(response.statusCode)
      })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(200)
  })

  it('rejects a shared directory before binding', async () => {
    const { app, directory, socket } = fixture()
    chmodSync(directory, 0o750)
    await expect(listen(app, { socket, host: '127.0.0.1', port: 0 })).rejects.toThrow(
      'private directory',
    )
    expect(app.server.listening).toBe(false)
  })

  it('rejects relative socket paths', async () => {
    const { app } = fixture()
    await expect(
      listen(app, { socket: 'control.sock', host: '127.0.0.1', port: 0 }),
    ).rejects.toThrow('absolute path')
  })

  it('preserves the default TCP listener', async () => {
    const { app } = fixture()
    await listen(app, { host: '127.0.0.1', port: 0 })
    expect(typeof app.server.address()).toBe('object')
    expect(app.server.listening).toBe(true)
  })
})
