import { describe, expect, it, vi } from 'vitest'
import { PtyBroker, type PtyLike, type PtySpawn, WriteLock, attachArgs } from './ptyBroker.js'
import type { Repo } from './types.js'

const repo: Repo = {
  id: 'svc',
  name: 'svc',
  path: '/p',
  configPath: '/p/devspace.yaml',
  ports: [],
  session: 'devdock-svc',
}

describe('attachArgs', () => {
  it('uses -r for read-only', () => {
    expect(attachArgs('s', 'ro')).toEqual(['attach', '-r', '-t', 's'])
    expect(attachArgs('s', 'rw')).toEqual(['attach', '-t', 's'])
  })
})

describe('WriteLock', () => {
  it('allows one holder and releases by token', () => {
    const lock = new WriteLock()
    const t = lock.acquire('svc')
    expect(t).not.toBeNull()
    expect(lock.acquire('svc')).toBeNull()
    expect(lock.release('svc', Symbol('wrong'))).toBe(false)
    expect(lock.release('svc', t as symbol)).toBe(true)
    expect(lock.acquire('svc')).not.toBeNull()
  })
})

function fakePty(): PtyLike & { written: string[]; exit: () => void } {
  let onExit = () => {}
  const written: string[] = []
  return {
    written,
    onData: () => {},
    onExit: (cb) => {
      onExit = cb
    },
    write: (d) => written.push(d),
    resize: () => {},
    kill: vi.fn(),
    exit: () => onExit(),
  }
}

describe('PtyBroker', () => {
  const spawnOf =
    (pty: PtyLike): PtySpawn =>
    () =>
      pty

  it('read-only sessions ignore writes and need no lock', async () => {
    const pty = fakePty()
    const broker = new PtyBroker(spawnOf(pty))
    const term = await broker.open(repo, 'ro')
    term.write('rm -rf /')
    expect(pty.written).toEqual([])
    expect(broker.locks.isHeld('svc')).toBe(false)
  })

  it('read-write holds the lock until close, blocking a second rw', async () => {
    const broker = new PtyBroker(spawnOf(fakePty()))
    const term = await broker.open(repo, 'rw')
    expect(broker.locks.isHeld('svc')).toBe(true)
    await expect(broker.open(repo, 'rw')).rejects.toThrow(/write-lock/)
    term.close()
    expect(broker.locks.isHeld('svc')).toBe(false)
  })

  it('releases the lock when the pty exits', async () => {
    const pty = fakePty()
    const broker = new PtyBroker(spawnOf(pty))
    await broker.open(repo, 'rw')
    expect(broker.locks.isHeld('svc')).toBe(true)
    pty.exit()
    expect(broker.locks.isHeld('svc')).toBe(false)
  })
})
