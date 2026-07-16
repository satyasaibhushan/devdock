import { describe, expect, it } from 'vitest'
import { LineSplitter, run, runStream } from './exec.js'

describe('run', () => {
  it('reports timedOut when the timeout kills the process', async () => {
    const r = await run('node', ['-e', 'setTimeout(() => {}, 60_000)'], { timeoutMs: 100 })
    expect(r.timedOut).toBe(true)
    expect(r.code).not.toBe(0)
  })

  it('keeps the tail when output exceeds maxOutputBytes', async () => {
    const r = await run('node', ['-e', `process.stdout.write('x'.repeat(5000) + 'THE-END')`], {
      maxOutputBytes: 100,
    })
    expect(r.code).toBe(0)
    expect(r.truncated).toBe(true)
    expect(r.stdout.length).toBeLessThanOrEqual(100)
    expect(r.stdout.endsWith('THE-END')).toBe(true)
  })

  it('leaves flags falsy on a clean run', async () => {
    const r = await run('node', ['-e', `process.stdout.write('ok')`])
    expect(r.code).toBe(0)
    expect(r.timedOut).toBe(false)
    expect(r.truncated).toBe(false)
  })
})

describe('LineSplitter', () => {
  it('emits whole lines, carrying partials across chunks', () => {
    const out: string[] = []
    const s = new LineSplitter((l) => out.push(l))
    s.ingest('a\nb')
    s.ingest('c\nd')
    expect(out).toEqual(['a', 'bc'])
    s.flush()
    expect(out).toEqual(['a', 'bc', 'd'])
  })
})

describe('runStream', () => {
  it('emits output lines as they arrive and still captures the result', async () => {
    const lines: string[] = []
    const r = await runStream(
      'node',
      ['-e', `console.log('one'); console.error('two'); process.stdout.write('three')`],
      {},
      (l) => lines.push(l),
    )
    expect(r.code).toBe(0)
    expect(lines).toContain('one')
    expect(lines).toContain('two')
    expect(lines).toContain('three') // trailing partial flushed on close
    expect(r.stdout).toContain('one')
    expect(r.stderr).toContain('two')
  })

  it('reports a missing binary like a shell (127), never rejects', async () => {
    const lines: string[] = []
    const r = await runStream('devdock-no-such-cmd', [], {}, (l) => lines.push(l))
    expect(r.code).toBe(127)
    expect(lines.join('\n')).toContain('command not found')
  })
})
