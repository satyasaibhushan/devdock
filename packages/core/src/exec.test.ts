import { describe, expect, it } from 'vitest'
import { LineSplitter, runStream } from './exec.js'

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
