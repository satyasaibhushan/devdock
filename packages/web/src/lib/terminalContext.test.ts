import { describe, expect, it } from 'vitest'
import type { TermInfo } from './api'
import { terminalLabel, terminalVisible } from './terminalContext'

const terminal: TermInfo = {
  id: 'accounts.api:t2',
  repo: 'accounts',
  workload: 'api',
  kind: 'shell',
  attach: 'pod',
  alive: true,
  createdAt: 1,
  lastUsedAt: 1,
  attached: 0,
}
describe('shared terminal visibility', () => {
  it('shows every registered live kind in the machine view regardless of repo or creator', () => {
    for (const kind of ['auto', 'shell', 'local'] as const)
      expect(terminalVisible({ ...terminal, kind }, true)).toBe(true)
    expect(
      terminalVisible({ ...terminal, repo: undefined, workload: undefined, kind: 'local' }, true),
    ).toBe(true)
    expect(terminalVisible({ ...terminal, alive: false }, true)).toBe(false)
  })
  it('keeps repo views scoped while including agent-opened host shells in that repo', () => {
    expect(terminalVisible(terminal, false, 'accounts', 'api')).toBe(true)
    expect(
      terminalVisible({ ...terminal, kind: 'local', attach: 'host' }, false, 'accounts', 'api'),
    ).toBe(true)
    expect(terminalVisible(terminal, false, 'accounts', 'worker')).toBe(false)
    expect(terminalVisible(terminal, false, 'other', 'api')).toBe(false)
  })
  it('labels the actual attach target, not the terminal creation mode', () => {
    expect(terminalLabel(terminal, 'devbox')).toBe('DevSpace · accounts / api')
    expect(terminalLabel({ ...terminal, attach: 'host' }, 'devbox')).toBe('Host · devbox')
  })
})
