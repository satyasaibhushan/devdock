import { describe, expect, it } from 'vitest'
import { CrashWatch, looksLikeTraceback } from './crashWatch.js'
import type { PodInfo } from './types.js'

const pod = (over: Partial<PodInfo> = {}): PodInfo => ({
  name: 'p',
  phase: 'Running',
  ready: true,
  restartCount: 0,
  ...over,
})

describe('looksLikeTraceback', () => {
  it('matches python tracebacks and exit markers', () => {
    expect(looksLikeTraceback('Traceback (most recent call last):')).toBe(true)
    expect(looksLikeTraceback('ValueError: bad')).toBe(true)
    expect(looksLikeTraceback('process exited with code 1')).toBe(true)
    expect(looksLikeTraceback('panic: nil pointer')).toBe(true)
  })
  it('ignores normal lines', () => {
    expect(looksLikeTraceback('INFO server started on :8080')).toBe(false)
  })
})

describe('CrashWatch', () => {
  it('emits once when restartCount climbs, not on first sight', () => {
    const cw = new CrashWatch('svc')
    const seen: string[] = []
    cw.onCrash((e) => seen.push(e.reason))
    expect(cw.observePods([pod({ restartCount: 0 })])).toEqual([])
    const ev = cw.observePods([pod({ restartCount: 2 })])
    expect(ev).toHaveLength(1)
    expect(ev[0]?.reason).toBe('restart')
    expect(ev[0]?.repo).toBe('svc')
    cw.observePods([pod({ restartCount: 2 })]) // no further climb
    expect(seen).toEqual(['restart'])
  })

  it('flags Failed phase', () => {
    const cw = new CrashWatch('svc')
    expect(cw.observePods([pod({ phase: 'Failed', ready: false })])[0]?.reason).toBe('failed')
  })

  it('emits a traceback crash from a log line', () => {
    const cw = new CrashWatch('svc')
    expect(cw.observeLog('p', 'KeyError: x')?.reason).toBe('traceback')
    expect(cw.observeLog('p', 'all good')).toBeUndefined()
  })
})
