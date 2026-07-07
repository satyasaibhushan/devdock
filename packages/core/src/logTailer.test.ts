import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { LogHub, LogTailer, RingBuffer, cleanLine } from './logTailer.js'
import type { PodInfo, Repo } from './types.js'

function fakeChild() {
  const fake = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: () => void
  }
  fake.stdout = new EventEmitter()
  fake.stderr = new EventEmitter()
  fake.kill = vi.fn()
  return fake
}

describe('RingBuffer', () => {
  it('drops oldest beyond capacity', () => {
    const r = new RingBuffer<number>(2)
    r.push(1)
    r.push(2)
    r.push(3)
    expect(r.toArray()).toEqual([2, 3])
  })
})

describe('LogHub', () => {
  it('replays backlog to new subscribers then streams live', () => {
    const hub = new LogHub()
    hub.push('a')
    const seen: string[] = []
    const off = hub.subscribe((l) => seen.push(l))
    hub.push('b')
    expect(seen).toEqual(['a', 'b'])
    off()
    hub.push('c')
    expect(seen).toEqual(['a', 'b'])
  })

  it('recent returns the tail', () => {
    const hub = new LogHub()
    for (let i = 0; i < 5; i++) hub.push(String(i))
    expect(hub.recent(2)).toEqual(['3', '4'])
  })

  it('strips ANSI styling and keeps the final \\r frame', () => {
    expect(cleanLine('\x1b[1;31mfatal \x1b[0mparse variables')).toBe('fatal parse variables')
    expect(cleanLine('building 1/3\rbuilding 2/3\rbuilding 3/3')).toBe('building 3/3')
    expect(cleanLine('plain line\r')).toBe('plain line')
    const hub = new LogHub()
    hub.push('\x1b[1;36minfo \x1b[0mhello')
    expect(hub.recent()).toEqual(['info hello'])
  })

  it('replay: false delivers only new lines', () => {
    const hub = new LogHub()
    hub.push('old')
    const seen: string[] = []
    hub.subscribe((l) => seen.push(l), { replay: false })
    hub.push('new')
    expect(seen).toEqual(['new'])
  })
})

describe('LogTailer', () => {
  const repo: Repo = {
    id: 'svc',
    name: 'svc',
    path: '/p',
    configPath: '/p/devspace.yaml',
    namespace: 'ns',
    ports: [],
    session: 'devdock-svc',
  }
  const pod: PodInfo = { name: 'pod-1', phase: 'Running', ready: true, restartCount: 0 }

  it('splits stdout chunks into whole lines, carrying partials', () => {
    const fake = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: () => void
    }
    fake.stdout = new EventEmitter()
    fake.stderr = new EventEmitter()
    fake.kill = vi.fn()
    const spawnFn = vi.fn(() => fake as never)

    const tailer = new LogTailer(spawnFn)
    const seen: string[] = []
    tailer.hub.subscribe((l) => seen.push(l))
    tailer.start(repo, pod, 'app')

    expect(spawnFn).toHaveBeenCalledWith('kubectl', [
      'logs',
      '-f',
      'pod-1',
      '-n',
      'ns',
      '-c',
      'app',
    ])

    fake.stdout.emit('data', Buffer.from('line1\nlin'))
    fake.stdout.emit('data', Buffer.from('e2\n'))
    expect(seen).toEqual(['line1', 'line2'])

    tailer.stop()
    expect(fake.kill).toHaveBeenCalled()
  })

  it('writes into a shared hub when given one', () => {
    const fake = fakeChild()
    const hub = new LogHub()
    hub.push('verb output')
    const tailer = new LogTailer(
      vi.fn(() => fake as never),
      hub,
    )
    tailer.start(repo, pod)
    fake.stdout.emit('data', Buffer.from('pod log\n'))
    expect(hub.recent()).toEqual(['verb output', 'pod log'])
  })
})
