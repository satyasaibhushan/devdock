import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { request } from 'node:http'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

export interface InstanceIdentity {
  id: string
  name: string
  protocol: number
}
export interface InstanceLink extends InstanceIdentity {
  host: string
  endpoint: string
  terminals: boolean
  reverse?: boolean
  returnId?: string
  returnEndpoint?: string
}
export interface PeerResponse {
  status: number
  body: Buffer
  contentType: string
}

export function loadIdentity(directory: string): InstanceIdentity {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'instance.json')
  try {
    writeFileSync(path, JSON.stringify({ id: randomUUID(), name: hostname(), protocol: 1 }), {
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const identity = JSON.parse(readFileSync(path, 'utf8')) as InstanceIdentity
  if (!/^[a-f0-9-]{36}$/.test(identity.id) || identity.protocol !== 1)
    throw new Error('Invalid instance identity')
  return identity
}

export function validateLink(host: string, endpoint: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,127}$/.test(host)) throw new Error('Use an SSH host alias')
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(endpoint) && !/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(endpoint)) {
    throw new Error('Endpoint must be an absolute Unix socket or 127.0.0.1:port')
  }
}

/** Only application control crosses a link. Credentials and recursive peer routing never do. */
export function peerPathAllowed(path: string, terminals: boolean): boolean {
  let pathname: string
  try {
    pathname = decodeURIComponent(path.split('?')[0] ?? '')
  } catch {
    return false
  }
  if (/%|\\|\.\./.test(pathname)) return false
  if (
    [
      '/instance',
      '/health',
      '/auth',
      '/auth/login',
      '/auth/clear',
      '/namespace',
      '/repos',
      '/replicas',
      '/replicas/gc',
      '/events',
    ].includes(pathname)
  )
    return true
  if (
    /^\/repos\/[a-zA-Z0-9_.-]+(?:\/(?:checkout|prerequisites|operations|pods|logs(?:\/query)?|branches|replicas|run|wait|exec|startup|start|build|build-start|restart|destroy|adopt|clear|stop-session))?$/.test(
      pathname,
    )
  )
    return true
  if (/^\/replicas\/[a-zA-Z0-9_.-]+$/.test(pathname)) return true
  if (/^\/operations(?:\/[a-zA-Z0-9-]+)?$/.test(pathname)) return true
  return (
    terminals && /^\/terminals(?:\/[a-zA-Z0-9_.:-]+(?:\/(?:attach|run|output))?)?$/.test(pathname)
  )
}

export interface InstanceConnection {
  connect(): Promise<string>
  close(): void
}

class Tunnel implements InstanceConnection {
  private child?: ChildProcess
  private directory?: string
  private connecting?: Promise<string>
  private closed = false
  constructor(private readonly link: ConnectionOptions) {}

  connect(): Promise<string> {
    if (this.closed) return Promise.reject(new Error('Instance unlinked'))
    if (this.connecting) return this.connecting
    this.connecting = this.open().catch((error: unknown) => {
      this.connecting = undefined
      throw error
    })
    return this.connecting
  }

  private async open(): Promise<string> {
    validateLink(this.link.host, this.link.endpoint)
    let returnSocket: string | undefined
    if (this.link.returnId && this.link.returnEndpoint) {
      const probe = new Tunnel({ host: this.link.host, endpoint: this.link.endpoint })
      try {
        const response = await socketRequest(
          await probe.connect(),
          'POST',
          '/instance/return-link/prepare',
          { id: this.link.returnId },
          5000,
        )
        const data = JSON.parse(response.body.toString()) as { socket?: string }
        if (response.status !== 200 || !data.socket)
          throw new Error('Cannot prepare return connection')
        validateLink(this.link.host, data.socket)
        returnSocket = data.socket
      } finally {
        probe.close()
      }
    }
    if (this.closed) throw new Error('Instance unlinked')
    this.directory = mkdtempSync(join(tmpdir(), 'devdock-peer-'))
    chmodSync(this.directory, 0o700)
    const socket = join(this.directory, 'control.sock')
    const child = spawn(
      'ssh',
      [
        '-N',
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ConnectTimeout=8',
        '-o',
        'ServerAliveInterval=15',
        '-o',
        'ServerAliveCountMax=2',
        '-o',
        'StreamLocalBindMask=0177',
        '-L',
        `${socket}:${this.link.endpoint}`,
        ...(returnSocket ? ['-R', `${returnSocket}:${this.link.returnEndpoint}`] : []),
        this.link.host,
      ],
      { stdio: 'ignore' },
    )
    this.child = child
    let failed = false
    const cleanup = () => {
      failed = true
      if (this.child === child) {
        this.child = undefined
        this.connecting = undefined
      }
      rmSync(socket, { force: true })
      try {
        rmSync(socket.slice(0, socket.lastIndexOf('/')), { recursive: true, force: true })
      } catch {
        /* private temporary directory */
      }
    }
    child.once('error', cleanup)
    child.once('exit', cleanup)
    for (let i = 0; i < 100; i++) {
      if (this.closed) child.kill()
      if (failed || this.closed)
        throw new Error('SSH connection failed; check the host alias and socket')
      if (existsSync(socket)) return socket
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    child.kill()
    throw new Error('SSH connection timed out')
  }

  close(): void {
    this.closed = true
    this.child?.kill()
  }
}

export function socketRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 180_000,
): Promise<PeerResponse> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body)
    const req = request(
      {
        socketPath,
        path,
        method,
        headers: {
          host: 'localhost',
          ...(encoded
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        let bytes = 0
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 8 * 1024 * 1024) {
            res.destroy()
            reject(new Error('Peer response too large'))
            return
          }
          chunks.push(chunk)
        })
        res.on('error', reject)
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 502,
            body: Buffer.concat(chunks),
            contentType: String(res.headers['content-type'] ?? 'application/json'),
          }),
        )
      },
    )
    const timer = setTimeout(
      () =>
        req.destroy(
          new Error(
            'Peer request timed out; operation may still be running. Check status before retrying.',
          ),
        ),
      timeoutMs,
    )
    req.on('close', () => clearTimeout(timer))
    req.on('error', reject)
    req.end(encoded)
  })
}

export class Instances {
  readonly identity: InstanceIdentity
  private links = new Map<string, InstanceLink>()
  private tunnels = new Map<string, InstanceConnection>()
  private timer?: NodeJS.Timeout
  private maintaining = false
  constructor(
    private readonly directory: string,
    private readonly connection: (link: ConnectionOptions) => InstanceConnection = (link) =>
      link.reverse ? { connect: async () => link.endpoint, close() {} } : new Tunnel(link),
    private readonly localEndpoint?: string,
  ) {
    this.identity = loadIdentity(directory)
    const file = join(directory, 'instances.json')
    if (existsSync(file)) {
      for (const link of JSON.parse(readFileSync(file, 'utf8')) as InstanceLink[]) {
        validateLink(link.host, link.endpoint)
        this.links.set(
          link.id,
          link.returnId && localEndpoint ? { ...link, returnEndpoint: localEndpoint } : link,
        )
      }
    }
  }
  prepareReturn(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id) || id === this.identity.id)
      throw new Error('Invalid return instance')
    const directory = join(this.directory, 'peers')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    const socket = join(directory, `${id}.sock`)
    // OpenSSH leaves its Unix listener pathname behind after disconnect.
    if (existsSync(socket)) {
      if (!lstatSync(socket).isSocket()) throw new Error('Return path is not a socket')
      rmSync(socket)
    }
    return socket
  }
  async acceptReturn(id: string, terminals: boolean): Promise<InstanceLink> {
    if (!/^[a-f0-9-]{36}$/.test(id) || id === this.identity.id)
      throw new Error('Invalid return instance')
    const endpoint = join(this.directory, 'peers', `${id}.sock`)
    const response = await socketRequest(endpoint, 'GET', '/instance', undefined, 5000)
    const identity = JSON.parse(response.body.toString()) as InstanceIdentity
    if (response.status !== 200 || identity.id !== id || identity.protocol !== 1)
      throw new Error('Return instance identity mismatch')
    const link = {
      id: identity.id,
      name: identity.name,
      protocol: identity.protocol,
      host: id,
      endpoint,
      terminals,
      reverse: true,
    }
    this.tunnels.get(id)?.close()
    this.tunnels.delete(id)
    this.links.set(id, link)
    this.save()
    return link
  }
  list(): InstanceLink[] {
    return [...this.links.values()]
  }
  private save(): void {
    const file = join(this.directory, 'instances.json')
    writeFileSync(`${file}.tmp`, JSON.stringify(this.list(), null, 2), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
  async link(host: string, endpoint: string, terminals = false): Promise<InstanceLink> {
    validateLink(host, endpoint)
    let tunnel = this.connection({ host, endpoint })
    try {
      const response = await socketRequest(
        await tunnel.connect(),
        'GET',
        '/instance',
        undefined,
        5000,
      )
      const identity = JSON.parse(response.body.toString()) as InstanceIdentity
      if (
        response.status !== 200 ||
        identity.protocol !== 1 ||
        !/^[a-f0-9-]{36}$/.test(identity.id)
      )
        throw new Error('Peer needs a compatible DevDock version')
      if (identity.id === this.identity.id) throw new Error('Cannot link an instance to itself')
      const link: InstanceLink = {
        id: identity.id,
        name: identity.name,
        protocol: identity.protocol,
        host,
        endpoint,
        terminals,
      }
      this.tunnels.get(link.id)?.close()
      if (this.localEndpoint) {
        link.returnId = this.identity.id
        link.returnEndpoint = this.localEndpoint
        tunnel.close()
        tunnel = this.connection(link)
        const socket = await tunnel.connect()
        let registered = false
        for (let attempt = 0; attempt < 20; attempt++) {
          const response = await socketRequest(
            socket,
            'POST',
            '/instance/return-link',
            { id: this.identity.id, terminals },
            5000,
          )
          if (response.status === 200) {
            registered = true
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        if (!registered) throw new Error('Return connection unavailable; no link saved')
      }
      this.links.set(link.id, link)
      this.tunnels.set(link.id, tunnel)
      this.save()
      return link
    } catch (error) {
      tunnel.close()
      throw error
    }
  }
  unlink(id: string): void {
    this.tunnels.get(id)?.close()
    this.tunnels.delete(id)
    this.links.delete(id)
    this.save()
  }
  private async socket(id: string, path: string): Promise<string> {
    const link = this.links.get(id)
    if (!link) throw new Error('Unknown instance')
    if (!peerPathAllowed(path, link.terminals))
      throw new Error('This operation is not allowed across the instance link')
    let tunnel = this.tunnels.get(id)
    if (!tunnel) {
      tunnel = this.connection(link)
      this.tunnels.set(id, tunnel)
    }
    const socket = await tunnel.connect()
    // SSH authenticates the machine; pin the daemon identity too, including after reconnect.
    const response = await socketRequest(socket, 'GET', '/instance', undefined, 5000)
    const identity = JSON.parse(response.body.toString()) as InstanceIdentity
    if (response.status !== 200 || identity.id !== id || identity.protocol !== 1)
      throw new Error('Peer identity changed; relink explicitly')
    return socket
  }
  async request(id: string, method: string, path: string, body?: unknown): Promise<PeerResponse> {
    return socketRequest(await this.socket(id, path), method, path, body)
  }
  async stream(id: string, path: string): Promise<WebSocket> {
    return new WebSocket(`ws+unix://${await this.socket(id, path)}:${path}`, {
      handshakeTimeout: 10_000,
      maxPayload: 1024 * 1024,
    })
  }
  start(): void {
    const maintain = async () => {
      if (this.maintaining) return
      this.maintaining = true
      try {
        await Promise.all(
          this.list()
            .filter((link) => !link.reverse)
            .map((link) => this.request(link.id, 'GET', '/instance').catch(() => undefined)),
        )
      } finally {
        this.maintaining = false
      }
    }
    void maintain()
    this.timer = setInterval(maintain, 15_000)
    this.timer.unref()
  }
  close(): void {
    if (this.timer) clearInterval(this.timer)
    for (const tunnel of this.tunnels.values()) tunnel.close()
  }
}

type ConnectionOptions = Pick<
  InstanceLink,
  'host' | 'endpoint' | 'reverse' | 'returnId' | 'returnEndpoint'
>
