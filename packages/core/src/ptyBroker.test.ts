import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PtyBroker,
  type PtyLike,
  type PtySpawn,
  WriteLock,
  attachArgs,
  ensureExecutable,
} from './ptyBroker.js'
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
  it('matches the session name exactly; no -r even for read-only (it would block wheel scrolling)', () => {
    expect(attachArgs('s', 'ro')).toEqual(['attach', '-t', '=s'])
    expect(attachArgs('s', 'rw')).toEqual(['attach', '-t', '=s'])
  })
})

describe('ensureExecutable', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('adds executable bits to a helper left non-executable by package extraction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devdock-pty-'))
    dirs.push(dir)
    const helper = join(dir, 'spawn-helper')
    writeFileSync(helper, '#!/bin/sh\n')
    chmodSync(helper, 0o644)

    ensureExecutable(helper)

    expect(statSync(helper).mode & 0o111).toBe(0o111)
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

  it('read-only sessions let mouse-wheel reports through (scrolling), nothing else', async () => {
    const pty = fakePty()
    const broker = new PtyBroker(spawnOf(pty))
    const term = await broker.open(repo, 'ro')
    const wheelUp = '\x1b[<64;10;5M'
    const wheelBurst = '\x1b[<65;10;5M\x1b[<65;10;5M'
    term.write(wheelUp)
    term.write(wheelBurst)
    term.write('\x1b[<0;10;5M') // a click is not a wheel report
    term.write('q\x1b[<64;10;5M') // smuggling a key alongside a wheel report
    expect(pty.written).toEqual([wheelUp, wheelBurst])
  })

  it('read-write holds the lock until close, blocking a second rw', async () => {
    const broker = new PtyBroker(spawnOf(fakePty()))
    const term = await broker.open(repo, 'rw')
    expect(broker.locks.isHeld('svc')).toBe(true)
    await expect(broker.open(repo, 'rw')).rejects.toThrow(/write-lock/)
    term.close()
    expect(broker.locks.isHeld('svc')).toBe(false)
  })

  it('releases the write-lock when spawning the terminal fails', async () => {
    const broker = new PtyBroker(() => {
      throw new Error('PTY spawn failed')
    })

    await expect(broker.open(repo, 'rw')).rejects.toThrow('PTY spawn failed')
    expect(broker.locks.isHeld('svc')).toBe(false)
  })

  it('openShell runs `devspace enter` in the repo directory', async () => {
    const calls: Array<{ file: string; args: string[]; cwd?: string }> = []
    const pty = fakePty()
    const spawn: PtySpawn = (file, args, opts) => {
      calls.push({ file, args, cwd: opts.cwd })
      return pty
    }
    const broker = new PtyBroker(spawn)
    const term = await broker.openShell(repo, 'ro')
    expect(calls).toEqual([
      { file: 'devspace', args: ['enter', '--pick=false', '--wait'], cwd: '/p' },
    ])
    term.write('whoami')
    expect(pty.written).toEqual([])
  })

  it('openShell pins --pod when given one (shared namespace would mis-pick otherwise)', async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const spawn: PtySpawn = (file, args) => {
      calls.push({ file, args })
      return fakePty()
    }
    const broker = new PtyBroker(spawn)
    await broker.openShell(repo, 'rw', 80, 24, 'svc-devspace-abc123')
    expect(calls[0]).toEqual({
      file: 'devspace',
      args: ['enter', '--pod', 'svc-devspace-abc123', '--wait'],
    })
  })

  it('openLocal spawns a login shell, defaulting to $SHELL and the home directory', async () => {
    const calls: Array<{ file: string; args: string[]; cwd?: string }> = []
    const spawn: PtySpawn = (file, args, opts) => {
      calls.push({ file, args, cwd: opts.cwd })
      return fakePty()
    }
    const broker = new PtyBroker(spawn)
    await broker.openLocal('rw', 80, 24, '/somewhere')
    expect(calls[0]).toEqual({
      file: process.env.SHELL ?? '/bin/zsh',
      args: ['-l'],
      cwd: '/somewhere',
    })
    expect(broker.locks.isHeld('local')).toBe(false)
  })

  it('openShell pins -n when the repo carries a namespace (config or session pin)', async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const spawn: PtySpawn = (file, args) => {
      calls.push({ file, args })
      return fakePty()
    }
    const broker = new PtyBroker(spawn)
    await broker.openShell({ ...repo, namespace: 'panels' }, 'ro', 80, 24, 'svc-devspace-abc123')
    expect(calls[0]?.args).toEqual([
      'enter',
      '--pod',
      'svc-devspace-abc123',
      '--wait',
      '-n',
      'panels',
    ])
  })

  it('openShell does not take the write-lock — pod shells are independent', async () => {
    const broker = new PtyBroker(spawnOf(fakePty()))
    // Each `devspace enter` is its own exec into the pod, so any number can run
    // read-write at once (VS Code-style multiple terminals into one pod).
    await broker.openShell(repo, 'rw')
    expect(broker.locks.isHeld('svc')).toBe(false)
    await expect(broker.openShell(repo, 'rw')).resolves.toBeTruthy()
    // The shared tmux session still locks, independently of the pod shells.
    await broker.open(repo, 'rw')
    expect(broker.locks.isHeld('svc')).toBe(true)
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
