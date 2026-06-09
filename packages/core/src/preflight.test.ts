import { describe, expect, it, vi } from 'vitest'
import type { RunResult } from './exec.js'
import { checkTools, missingToolWarnings } from './preflight.js'

const tools = [
  { name: 'tmux', required: true, hint: 'brew install tmux' },
  { name: 'kubectl', required: true, hint: 'see docs' },
]

describe('checkTools', () => {
  it('marks a tool present when --version exits non-127', async () => {
    const runner = vi.fn(
      async (cmd: string): Promise<RunResult> => ({
        code: cmd === 'tmux' ? 127 : 0,
        stdout: '',
        stderr: '',
      }),
    )
    const statuses = await checkTools(tools, runner)
    expect(statuses.find((s) => s.name === 'tmux')?.present).toBe(false)
    expect(statuses.find((s) => s.name === 'kubectl')?.present).toBe(true)
  })
})

describe('missingToolWarnings', () => {
  it('warns only for absent tools, with the install hint', () => {
    const warnings = missingToolWarnings([
      { name: 'tmux', required: true, hint: 'brew install tmux', present: false },
      { name: 'kubectl', required: true, hint: 'see docs', present: true },
    ])
    expect(warnings).toEqual(["missing CLI 'tmux' — install: brew install tmux"])
  })
})
