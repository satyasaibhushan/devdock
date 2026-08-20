import { describe, expect, it } from 'vitest'
import { AccessGate } from './accessGate.js'

describe('AccessGate', () => {
  const gate = new AccessGate('secret')

  it('allows same-origin loopback browser requests', () => {
    expect(
      gate.authorize({
        remoteAddress: '127.0.0.1',
        host: '127.0.0.1:7717',
        origin: 'http://127.0.0.1:7717',
      }),
    ).toBe(true)
  })

  it('rejects cross-origin browser requests and remote unauthenticated clients', () => {
    expect(
      gate.authorize({
        remoteAddress: '127.0.0.1',
        host: '127.0.0.1:7717',
        origin: 'https://evil.example',
      }),
    ).toBe(false)
    expect(gate.authorize({ remoteAddress: '10.0.0.2' })).toBe(false)
  })

  it('allows a valid bearer token at any address', () => {
    expect(gate.authorize({ remoteAddress: '10.0.0.2', authorization: 'Bearer secret' })).toBe(true)
    expect(gate.authorize({ remoteAddress: '10.0.0.2', authorization: 'Bearer wrong' })).toBe(false)
  })
})
