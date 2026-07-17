// Preflight — devdock shells out to external CLIs (spec §5). Check they're on
// PATH at startup so a missing tool is a clear warning, not a crash mid-loop.
import { type RunResult, loginShell, loginShellArgs, run } from './exec.js'

export interface ToolCheck {
  name: string
  /** Whether the daemon can do anything useful without it. */
  required: boolean
  /** A short hint on how to get it. */
  hint: string
}

export const DEFAULT_TOOLS: ToolCheck[] = [
  { name: 'tmux', required: true, hint: 'brew install tmux' },
  { name: 'kubectl', required: true, hint: 'https://kubernetes.io/docs/tasks/tools/' },
  { name: 'git', required: true, hint: 'xcode-select --install (or brew install git)' },
  {
    name: 'devspace',
    required: true,
    hint: 'https://www.devspace.sh/docs/getting-started/installation',
  },
]

export interface ToolStatus extends ToolCheck {
  present: boolean
}

/** Probe each tool with `--version` (resolves 127 when absent — run never throws). */
export async function checkTools(
  tools: ToolCheck[] = DEFAULT_TOOLS,
  runner: (cmd: string, args: string[]) => Promise<RunResult> = run,
): Promise<ToolStatus[]> {
  return Promise.all(
    tools.map(async (t) => ({ ...t, present: (await runner(t.name, ['--version'])).code !== 127 })),
  )
}

/** Human-readable lines for any missing tools (empty array when all present). */
export function missingToolWarnings(statuses: ToolStatus[]): string[] {
  return statuses
    .filter((s) => !s.present)
    .map((s) => `${s.required ? 'missing' : 'optional'} CLI '${s.name}' — install: ${s.hint}`)
}

/** Warn when kubectl/helm/devspace resolve to Rancher Desktop's ~/.rd/bin
 *  shims, which proxy every call through Rancher and make devspace noticeably
 *  slow (documented in the team's Development-Environments wiki). Resolves in
 *  the same login shell the verbs use, so it reports what devspace will see. */
export async function pathShadowWarnings(
  runner: (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult> = run,
): Promise<string[]> {
  const r = await runner(loginShell, [loginShellArgs, 'command -v kubectl helm devspace'], {
    timeoutMs: 10_000,
  })
  if (r.code !== 0 && r.stdout.trim() === '') return []
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('/.rd/bin/'))
    .map(
      (l) =>
        `'${l.split('/').pop()}' resolves to the Rancher Desktop shim (${l}) — these shims make devspace/kubectl slow; put the homebrew bin dir ahead of ~/.rd/bin in PATH (or disable the shims in Rancher Desktop preferences)`,
    )
}
