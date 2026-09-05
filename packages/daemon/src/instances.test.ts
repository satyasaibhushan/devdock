import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Instances, loadIdentity, peerPathAllowed, validateLink } from './instances.js'

const dirs: string[] = []
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'instance-test-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('instance directory', () => {
  it('retains identity across restart without exposing writable identity files', () => {
    const dir = directory()
    expect(loadIdentity(dir)).toEqual(loadIdentity(dir))
    expect(statSync(join(dir, 'instance.json')).mode & 0o777).toBe(0o600)
    expect(new Instances(dir).identity.id).toBe(loadIdentity(dir).id)
  })
  it('accepts only SSH aliases and private daemon endpoints', () => {
    expect(() => validateLink('devbox', '/run/user/1000/devdock/control.sock')).not.toThrow()
    expect(() => validateLink('sai@devbox', '127.0.0.1:7717')).not.toThrow()
    for (const host of ['-oProxyCommand=bad', 'a;bad', 'a b', 'a\nb'])
      expect(() => validateLink(host, '/socket')).toThrow()
    for (const endpoint of ['example.org:443', '/tmp/a:bad', '$(bad)', '../socket'])
      expect(() => validateLink('devbox', endpoint)).toThrow()
  })
  it('blocks credentials, recursive routing and encoded traversal even with terminal access', () => {
    for (const path of [
      '/aws/credential',
      '/instances',
      '/instances/id/api/repos',
      '/repos/../aws/credential',
      '/repos/%2e%2e/credential',
      '//aws/credential',
    ]) {
      expect(peerPathAllowed(path, true)).toBe(false)
    }
    expect(peerPathAllowed('/repos/accounts/run', false)).toBe(true)
    expect(peerPathAllowed('/repos/accounts/stop-session?workload=api', false)).toBe(true)
    expect(peerPathAllowed('/repos/accounts/logs?workload=api', false)).toBe(true)
    expect(peerPathAllowed('/terminals/id/attach', false)).toBe(false)
    expect(peerPathAllowed('/terminals/id/attach', true)).toBe(true)
  })
  it('rejects an unknown instance before opening a connection', async () => {
    const instances = new Instances(directory())
    await expect(instances.request('missing', 'GET', '/repos')).rejects.toThrow('Unknown instance')
    instances.close()
  })
  it('pins peer identity, routes requests, persists links, and blocks credentials', async () => {
    const root = directory()
    const socket = join(root, 'peer.sock')
    let identity = { id: '12345678-1234-1234-1234-123456789012', name: 'devbox', protocol: 1 }
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify(req.url === '/instance' ? identity : { path: req.url, method: req.method }),
      )
    })
    await new Promise<void>((resolve) => server.listen(socket, resolve))
    const connect = () => ({ connect: async () => socket, close() {} })
    const instances = new Instances(root, connect)
    try {
      const link = await instances.link('devbox', '/run/user/1000/devdock/control.sock')
      expect(link.id).toBe(identity.id)
      const response = await instances.request(link.id, 'POST', '/repos/accounts/build', {})
      expect(JSON.parse(response.body.toString())).toEqual({
        method: 'POST',
        path: '/repos/accounts/build',
      })
      expect(new Instances(root, connect).list()).toEqual([link])
      await expect(instances.request(link.id, 'GET', '/aws/credential')).rejects.toThrow(
        'not allowed',
      )
      await expect(instances.stream(link.id, '/terminals/host%3At1/attach')).rejects.toThrow(
        'not allowed',
      )
      identity = { ...identity, id: 'aaaaaaaa-1234-1234-1234-123456789012' }
      await expect(instances.request(link.id, 'POST', '/repos/accounts/build')).rejects.toThrow(
        'identity changed',
      )
      instances.unlink(link.id)
      expect(new Instances(root, connect).list()).toEqual([])
    } finally {
      instances.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('registers a verified return socket without persisting peer auth data', async () => {
    const root = directory()
    const instances = new Instances(root)
    const id = 'bbbbbbbb-1234-1234-1234-123456789012'
    const socket = instances.prepareReturn(id)
    const server = createServer((_req, res) =>
      res.end(
        JSON.stringify({ id, name: 'laptop', protocol: 1, auth: { loginUrl: 'do-not-persist' } }),
      ),
    )
    await new Promise<void>((resolve) => server.listen(socket, resolve))
    try {
      const link = await instances.acceptReturn(id, true)
      expect(link.reverse).toBe(true)
      expect(link).not.toHaveProperty('auth')
      expect(new Instances(root).list()).toEqual([link])
      await expect(instances.request(id, 'GET', '/instance')).resolves.toHaveProperty('status', 200)
      expect(() => instances.prepareReturn('../outside')).toThrow('Invalid return')
    } finally {
      instances.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    writeFileSync(socket, 'not a socket')
    expect(() => instances.prepareReturn(id)).toThrow('not a socket')
  })
})
