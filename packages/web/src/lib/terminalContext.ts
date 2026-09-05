import type { TermInfo } from './api'

export function terminalVisible(
  terminal: TermInfo,
  all: boolean,
  repo?: string,
  workload?: string,
): boolean {
  if (!terminal.alive) return false
  if (all) return true
  return repo
    ? terminal.repo === repo && (terminal.workload ?? '') === (workload ?? '')
    : terminal.kind === 'local'
}

export function terminalLabel(terminal: TermInfo, machine: string): string {
  return terminal.attach === 'host'
    ? `Host · ${machine}`
    : `DevSpace · ${terminal.repo ?? 'pod'}${terminal.workload ? ` / ${terminal.workload}` : ''}`
}
