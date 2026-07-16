import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, readFileSlice } from './logQuery.js'

describe('cursor codec', () => {
  it('round-trips all three kinds', () => {
    const cases = [
      { kind: 'file', gen: 3, offset: 1024 },
      { kind: 'hub', seq: 42 },
      { kind: 'container', sinceTime: '2026-07-16T10:00:00Z' },
    ] as const
    for (const c of cases) expect(decodeCursor(encodeCursor(c))).toEqual(c)
  })

  it('returns undefined for garbage instead of throwing', () => {
    expect(decodeCursor(undefined)).toBeUndefined()
    expect(decodeCursor('')).toBeUndefined()
    expect(decodeCursor('x:1:2')).toBeUndefined()
    expect(decodeCursor('f:abc:def')).toBeUndefined()
    expect(decodeCursor('c:not-a-date')).toBeUndefined()
  })
})

describe('readFileSlice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devdock-logq-'))
  const file = (name: string, content: string) => {
    const p = join(dir, name)
    writeFileSync(p, content)
    return p
  }

  it('reads complete lines from an offset and resumes on a line boundary', () => {
    const p = file('a.log', 'one\ntwo\nthree\n')
    const first = readFileSlice(p, 0)
    expect(first?.lines).toEqual(['one', 'two', 'three'])
    // Append and resume from nextOffset — only the new line comes back.
    writeFileSync(p, 'one\ntwo\nthree\nfour\n')
    const second = readFileSlice(p, first?.nextOffset ?? 0)
    expect(second?.lines).toEqual(['four'])
  })

  it('leaves a trailing partial line for the next read', () => {
    const p = file('b.log', 'done\npart')
    const r = readFileSlice(p, 0)
    expect(r?.lines).toEqual(['done'])
    writeFileSync(p, 'done\npartial\n')
    const r2 = readFileSlice(p, r?.nextOffset ?? 0)
    expect(r2?.lines).toEqual(['partial'])
  })

  it('resyncs from the start when the file shrank below the offset', () => {
    const p = file('c.log', 'fresh\n')
    const r = readFileSlice(p, 9999)
    expect(r?.lines).toEqual(['fresh'])
  })

  it('caps at maxBytes keeping the tail and flags truncation', () => {
    const p = file('d.log', `${'x'.repeat(100)}\nkeep-me\nlast\n`)
    const r = readFileSlice(p, 0, 20)
    expect(r?.truncated).toBe(true)
    expect(r?.lines).toEqual(['keep-me', 'last'])
  })

  it('returns undefined for a missing file', () => {
    expect(readFileSlice(join(dir, 'nope.log'), 0)).toBeUndefined()
  })
})
