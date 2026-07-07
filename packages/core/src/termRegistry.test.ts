import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TermSession } from './ptyBroker.js'
import { TermRegistry, renderPtyText } from './termRegistry.js'

function fakeSession() {
  let dataCb: (d: string) => void = () => {}
  const exitCbs: Array<() => void> = []
  const writes: string[] = []
  const close = vi.fn()
  const session: TermSession = {
    mode: 'rw',
    onData: (cb) => {
      dataCb = cb
    },
    onExit: (cb) => {
      exitCbs.push(cb)
    },
    write: (d) => writes.push(d),
    resize: () => {},
    close,
  }
  return {
    session,
    writes,
    close,
    emit: (d: string) => dataCb(d),
    exit: () => {
      for (const cb of exitCbs) cb()
    },
  }
}

describe('renderPtyText', () => {
  it('strips ANSI styling, OSC titles and keypad escapes', () => {
    const raw = '\x1b]0;title\x07\x1b[31mred\x1b[0m\r\nplain\x1b=\r\n'
    expect(renderPtyText(raw)).toBe('red\nplain\n')
  })

  it('keeps only the final \\r-overwritten frame', () => {
    expect(renderPtyText('10%\r50%\r100%\r\ndone')).toBe('100%\ndone')
  })
})

describe('TermRegistry', () => {
  it('tracks sessions with sequential ids and buffers scrollback', () => {
    const reg = new TermRegistry()
    const a = fakeSession()
    const info = reg.add({ kind: 'local' }, a.session)
    expect(info.id).toBe('t1')
    expect(info.alive).toBe(true)
    a.emit('hello\r\n')
    a.emit('world')
    expect(reg.read('t1')).toBe('hello\nworld')
    expect(reg.list().map((t) => t.id)).toEqual(['t1'])
  })

  it('read tails the last N lines', () => {
    const reg = new TermRegistry()
    const a = fakeSession()
    reg.add({ kind: 'local' }, a.session)
    a.emit('one\r\ntwo\r\nthree')
    expect(reg.read('t1', 2)).toBe('two\nthree')
  })

  it('marks the session dead on pty exit; run then refuses', async () => {
    const reg = new TermRegistry()
    const a = fakeSession()
    reg.add({ kind: 'local' }, a.session)
    a.exit()
    expect(reg.list()[0]?.alive).toBe(false)
    await expect(reg.run('t1', 'ls')).rejects.toThrow(/exited/)
  })

  it('close tears down the session and forgets the id', () => {
    const reg = new TermRegistry()
    const a = fakeSession()
    reg.add({ kind: 'local' }, a.session)
    reg.close('t1')
    expect(a.close).toHaveBeenCalled()
    expect(() => reg.read('t1')).toThrow(/unknown terminal/)
  })

  describe('run', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('types the command and resolves once output goes quiet', async () => {
      const reg = new TermRegistry()
      const a = fakeSession()
      reg.add({ kind: 'local' }, a.session)

      const p = reg.run('t1', 'echo hi')
      expect(a.writes).toEqual(['echo hi\r'])
      a.emit('echo hi\r\n')
      await vi.advanceTimersByTimeAsync(300)
      a.emit('hi\r\n')
      await vi.advanceTimersByTimeAsync(900) // > RUN_QUIET_MS with no growth
      const r = await p
      expect(r.output).toBe('echo hi\nhi')
      expect(r.timedOut).toBe(false)
    })

    it('flags timedOut when output keeps flowing past timeoutMs', async () => {
      const reg = new TermRegistry()
      const a = fakeSession()
      reg.add({ kind: 'local' }, a.session)

      const p = reg.run('t1', 'tail -f log', 1000)
      for (let i = 0; i < 6; i++) {
        a.emit(`line ${i}\r\n`)
        await vi.advanceTimersByTimeAsync(200)
      }
      const r = await p
      expect(r.timedOut).toBe(true)
      expect(r.output).toContain('line 4')
    })

    it('rejects a second run while one is in flight', async () => {
      const reg = new TermRegistry()
      const a = fakeSession()
      reg.add({ kind: 'local' }, a.session)

      const p = reg.run('t1', 'sleep 5')
      await expect(reg.run('t1', 'ls')).rejects.toThrow(/busy/)
      await vi.advanceTimersByTimeAsync(900)
      await p
    })
  })

  it('sweep reaps idle terminals but never a running one', async () => {
    const reg = new TermRegistry()
    const a = fakeSession()
    reg.add({ kind: 'local' }, a.session)
    const later = Date.now() + 31 * 60 * 1000
    reg.sweep(undefined, later)
    expect(a.close).toHaveBeenCalled()
    expect(reg.list()).toEqual([])
  })

  it('sweep reaps a dead terminal after its grace, keeps a fresh live one', () => {
    const reg = new TermRegistry()
    const dead = fakeSession()
    const live = fakeSession()
    reg.add({ kind: 'local' }, dead.session)
    reg.add({ kind: 'local' }, live.session)
    dead.exit()
    reg.sweep(undefined, Date.now() + 2 * 60 * 1000)
    expect(dead.close).toHaveBeenCalled()
    expect(reg.list().map((t) => t.id)).toEqual(['t2'])
  })
})
