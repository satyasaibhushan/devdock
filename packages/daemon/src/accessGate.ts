import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface IngressRequest {
  authorization?: string
  host?: string
  origin?: string
  remoteAddress?: string
}

/** One authority decision for HTTP and WebSocket ingress. Same-origin browser
 * traffic and loopback clients are trusted; remote clients need the daemon
 * control token. */
export class AccessGate {
  constructor(private readonly token: string) {}

  static load(file: string): AccessGate {
    let token: string
    try {
      token = readFileSync(file, 'utf8').trim()
      if (!token) throw new Error('empty token')
    } catch {
      mkdirSync(dirname(file), { recursive: true })
      const generated = randomBytes(32).toString('base64url')
      try {
        writeFileSync(file, `${generated}\n`, { flag: 'wx', mode: 0o600 })
        token = generated
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        token = readFileSync(file, 'utf8').trim()
        if (!token) throw new Error(`empty control token: ${file}`)
      }
    }
    chmodSync(file, 0o600)
    return new AccessGate(token)
  }

  authorize(request: IngressRequest): boolean {
    if (this.matchesBearer(request.authorization)) return true
    if (!isLoopback(request.remoteAddress)) return false
    if (!request.origin) return true
    try {
      const origin = new URL(request.origin)
      return isLoopback(origin.hostname) && origin.host === request.host
    } catch {
      return false
    }
  }

  private matchesBearer(header: string | undefined): boolean {
    if (!header?.startsWith('Bearer ')) return false
    const supplied = Buffer.from(header.slice('Bearer '.length))
    const expected = Buffer.from(this.token)
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false
  const value = address.replace(/^::ffff:/, '').replace(/^\[|\]$/g, '')
  return value === '127.0.0.1' || value === '::1' || value === 'localhost'
}
