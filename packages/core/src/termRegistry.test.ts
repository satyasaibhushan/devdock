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
  it('tracks sessions with scoped sequential ids and buffers scrollback', () => {
    const reg = new TermRegistry()
    const a = fakeSession()
    const info = reg.add({ kind: 'local', attach: 'host' }, a.session)
    expect(info.id).toBe('host:t1')
    expect(info.alive).toBe(true)
    a.emit('hello\r\n')
    a.emit('world')
    expect(reg.read('host:t1')).toBe('hello\nworld')
    expect(reg.list().map((t) => t.id)).toEqual(['host:t1'])
  })

  it('numbers each repo/workload scope independently from t1', () => {
    const reg = new TermRegistry()
    expect(reg.add({ kind: 'auto', repo: 'api', attach: 'tmux' }, fakeSession().session).id).toBe(
      'api:t1',
    )
    expect(
      reg.add({ kind: 'shell', repo: 'svc', workload: 'api', attach: 'pod' }, fakeSession().session)
        .id,
    ).toBe('svc.api:t1')
    expect(
      reg.add({ kind: 'shell', repo: 'svc', workload: 'api', attach: 'pod' }, fakeSession().session)
        .id,
    ).toBe('svc.api:t2')
    expect(
      reg.add(
        { kind: 'shell', repo: 'svc', workload: 'cron', attach: 'pod' },
        fakeSession().session,
      ).id,
    ).toBe('svc.cron:t1')
    expect(reg.add({ kind: 'local', attach: 'host' }, fakeSession().session).id).toBe('host:t1')
  })

  it('read tails the last N lines', () => {
    const reg = new TermRegistry()
    const a = fakeSession()
    reg.add({ kind: 'local', attach: 'host' }, a.session)
    a.emit('one\r\ntwo\r\nthree')
    expect(reg.read('host:t1', 2)).toBe('two\nthree')
  })

  it('marks the session dead on pty exit; run then refuses', async () => {
    const reg = new TermRegistry()
    const a = fakeSession()
    reg.add({ kind: 'local', attach: 'host' }, a.session)
    a.exit()
    expect(reg.list()[0]?.alive).toBe(false)
    await expect(reg.run('host:t1', 'ls')).rejects.toThrow(/exited/)
  })

  it('close tears down the session and forgets the id', () => {
    const reg = new TermRegistry()
    const a = fakeSession()
    reg.add({ kind: 'local', attach: 'host' }, a.session)
    reg.close('host:t1')
    expect(a.close).toHaveBeenCalled()
    expect(() => reg.read('host:t1')).toThrow(/unknown terminal/)
  })

  describe('run', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('types the command and resolves once output goes quiet', async () => {
      const reg = new TermRegistry()
      const a = fakeSession()
      reg.add({ kind: 'local', attach: 'host' }, a.session)

      const p = reg.run('host:t1', 'echo hi')
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
      reg.add({ kind: 'local', attach: 'host' }, a.session)

      const p = reg.run('host:t1', 'tail -f log', 1000)
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
      reg.add({ kind: 'local', attach: 'host' }, a.session)

      const p = reg.run('host:t1', 'sleep 5')
      await expect(reg.run('host:t1', 'ls')).rejects.toThrow(/busy/)
      await vi.advanceTimersByTimeAsync(900)
      await p
    })
  })

  it('sweep reaps idle terminals but never a running one', async () => {
    const reg = new TermRegistry()
    const a = fakeSession()
    reg.add({ kind: 'local', attach: 'host' }, a.session)
    const later = Date.now() + 31 * 60 * 1000
    reg.sweep(undefined, later)
    expect(a.close).toHaveBeenCalled()
    expect(reg.list()).toEqual([])
  })

  it('sweep reaps a dead terminal after its grace, keeps a fresh live one', () => {
    const reg = new TermRegistry()
    const dead = fakeSession()
    const live = fakeSession()
    reg.add({ kind: 'local', attach: 'host' }, dead.session)
    reg.add({ kind: 'local', attach: 'host' }, live.session)
    dead.exit()
    reg.sweep(undefined, Date.now() + 2 * 60 * 1000)
    expect(dead.close).toHaveBeenCalled()
    expect(reg.list().map((t) => t.id)).toEqual(['host:t2'])
  })

  describe('attach', () => {
    // An SGR mouse-wheel report — the one input class ro viewers may send.
    const WHEEL = '\x1b[<64;10;10M'

    it('replays the scrollback, then streams live bytes to the watcher', () => {
      const reg = new TermRegistry()
      const a = fakeSession()
      reg.add({ kind: 'local', attach: 'host' }, a.session)
      a.emit('before\r\n')
      const seen: string[] = []
      const att = reg.attach('host:t1', 'ro', { onData: (d) => seen.push(d) })
      expect(att.replay).toBe('before\r\n')
      a.emit('after\r\n')
      expect(seen).toEqual(['after\r\n'])
      att.detach()
      a.emit('unseen')
      expect(seen).toEqual(['after\r\n'])
    })

    it('ro attachments pass wheel reports and drop keystrokes; rw passes all', () => {
      const reg = new TermRegistry()
      const a = fakeSession()
      reg.add({ kind: 'local', attach: 'host' }, a.session)
      const ro = reg.attach('host:t1', 'ro', { onData: () => {} })
      ro.write('rm -rf /\r')
      ro.write(WHEEL)
      expect(a.writes).toEqual([WHEEL])
      const rw = reg.attach('host:t1', 'rw', { onData: () => {} })
      rw.write('echo hi\r')
      expect(a.writes).toEqual([WHEEL, 'echo hi\r'])
    })

    it('detach never kills the session; close still does', () => {
      const reg = new TermRegistry()
      const a = fakeSession()
      reg.add({ kind: 'local', attach: 'host' }, a.session)
      reg.attach('host:t1', 'rw', { onData: () => {} }).detach()
      expect(a.close).not.toHaveBeenCalled()
      expect(reg.list()[0]?.alive).toBe(true)
      reg.close('host:t1')
      expect(a.close).toHaveBeenCalled()
    })

    it('notifies watchers when the PTY exits and refuses new attaches', () => {
      const reg = new TermRegistry()
      const a = fakeSession()
      reg.add({ kind: 'local', attach: 'host' }, a.session)
      const onExit = vi.fn()
      reg.attach('host:t1', 'ro', { onData: () => {}, onExit })
      a.exit()
      expect(onExit).toHaveBeenCalled()
      expect(() => reg.attach('host:t1', 'ro', { onData: () => {} })).toThrow(/exited/)
    })

    it('counts attached viewers in list()', () => {
      const reg = new TermRegistry()
      const a = fakeSession()
      reg.add({ kind: 'local', attach: 'host' }, a.session)
      const att1 = reg.attach('host:t1', 'ro', { onData: () => {} })
      reg.attach('host:t1', 'rw', { onData: () => {} })
      expect(reg.list()[0]?.attached).toBe(2)
      att1.detach()
      expect(reg.list()[0]?.attached).toBe(1)
    })

    it('sweep never reaps a live terminal with a viewer attached', () => {
      const reg = new TermRegistry()
      const a = fakeSession()
      reg.add({ kind: 'local', attach: 'host' }, a.session)
      const att = reg.attach('host:t1', 'ro', { onData: () => {} })
      reg.sweep(undefined, Date.now() + 31 * 60 * 1000)
      expect(a.close).not.toHaveBeenCalled()
      // once the viewer leaves, the idle clock restarts from the detach
      att.detach()
      reg.sweep(undefined, Date.now() + 29 * 60 * 1000)
      expect(a.close).not.toHaveBeenCalled()
      reg.sweep(undefined, Date.now() + 31 * 60 * 1000)
      expect(a.close).toHaveBeenCalled()
    })
  })

  describe('findLive', () => {
    it('matches on kind + repo + workload, skipping dead terminals', () => {
      const reg = new TermRegistry()
      const dead = fakeSession()
      const live = fakeSession()
      reg.add({ kind: 'auto', repo: 'api', workload: 'cron', attach: 'tmux' }, dead.session)
      reg.add({ kind: 'auto', repo: 'api', workload: 'cron', attach: 'pod' }, live.session)
      dead.exit()
      expect(reg.findLive('auto', 'api', 'cron')?.id).toBe('api.cron:t2')
      expect(reg.findLive('auto', 'api')).toBeUndefined()
      expect(reg.findLive('shell', 'api', 'cron')).toBeUndefined()
    })
  })
})
