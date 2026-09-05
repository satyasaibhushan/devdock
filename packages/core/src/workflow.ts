import { readFileSync } from 'node:fs'
import type { RunOptions, RunResult } from './exec.js'

export type WorkflowAction = 'build' | 'build_start' | 'start' | 'restart' | 'destroy' | 'verify'
export interface Prerequisite {
  id: string
  label: string
  command: string[]
  actions?: WorkflowAction[]
  timeoutMs?: number
}
export interface Verification {
  url: string
  status?: number
  contains?: string
  timeoutMs?: number
}
export interface WorkflowConfig {
  prerequisites: Prerequisite[]
  verification: Record<string, Verification>
}
export interface CheckResult {
  id: string
  label: string
  status: 'passed' | 'failed' | 'unknown'
  detail: string
}
type Runner = (command: string, args: string[], opts?: RunOptions) => Promise<RunResult>
const ACTIONS = new Set(['build', 'build_start', 'start', 'restart', 'destroy', 'verify'])
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function timeout(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 60_000)
  )
}

/** Only machine-local configuration supplies executable commands. Never accept them from a request or repo. */
export function loadWorkflowConfig(file: string): WorkflowConfig {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { prerequisites: [], verification: {} }
    throw new Error('Cannot read workflow configuration')
  }
  if (!object(raw)) throw new Error('Invalid workflow configuration')
  const checks = raw.prerequisites ?? []
  const verification = raw.verification ?? {}
  if (!Array.isArray(checks) || !object(verification))
    throw new Error('Invalid workflow configuration')
  const ids = new Set<string>()
  for (const c of checks) {
    if (
      !object(c) ||
      typeof c.id !== 'string' ||
      !/^[a-zA-Z0-9_-]+$/.test(c.id) ||
      ids.has(c.id) ||
      typeof c.label !== 'string' ||
      !c.label.trim() ||
      !Array.isArray(c.command) ||
      !c.command.length ||
      !c.command.every((arg) => typeof arg === 'string' && !arg.includes('\0')) ||
      !c.command[0] ||
      !timeout(c.timeoutMs) ||
      (c.actions !== undefined &&
        (!Array.isArray(c.actions) || !c.actions.every((a) => ACTIONS.has(a))))
    ) {
      throw new Error('Invalid prerequisite configuration')
    }
    ids.add(c.id)
  }
  for (const v of Object.values(verification)) {
    if (
      !object(v) ||
      typeof v.url !== 'string' ||
      !timeout(v.timeoutMs) ||
      (v.status !== undefined &&
        (typeof v.status !== 'number' ||
          !Number.isInteger(v.status) ||
          v.status < 100 ||
          v.status > 599)) ||
      (v.contains !== undefined && typeof v.contains !== 'string')
    )
      throw new Error('Invalid verification configuration')
    const url = new URL(v.url)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Invalid verification URL')
  }
  return {
    prerequisites: checks as unknown as Prerequisite[],
    verification: verification as Record<string, Verification>,
  }
}

export async function checkPrerequisites(
  checks: Prerequisite[],
  action: WorkflowAction,
  cwd: string,
  env: NodeJS.ProcessEnv,
  runner: Runner,
): Promise<CheckResult[]> {
  return Promise.all(
    checks
      .filter((c) => (c.actions ? c.actions.includes(action) : action !== 'destroy'))
      .map(async (c) => {
        try {
          const command = c.command[0]
          if (!command) throw new Error('Missing executable')
          const result = await runner(command, c.command.slice(1), {
            cwd,
            env,
            timeoutMs: c.timeoutMs ?? 10_000,
            maxOutputBytes: 1024,
          })
          // Exit 2 means indeterminate. Output stays private, checks may invoke credential helpers.
          const status =
            result.timedOut || [2, 126, 127, -1].includes(result.code)
              ? 'unknown'
              : result.code === 0
                ? 'passed'
                : 'failed'
          return {
            id: c.id,
            label: c.label,
            status,
            detail: result.timedOut ? 'Timed out' : `Exit ${result.code}`,
          } as CheckResult
        } catch {
          return {
            id: c.id,
            label: c.label,
            status: 'unknown',
            detail: 'Could not execute check',
          } as CheckResult
        }
      }),
  )
}

/** GET only, bounded response, no redirects or response body in logs. */
export async function verifyEndpoint(check: Verification): Promise<void> {
  const response = await fetch(check.url, {
    redirect: 'error',
    signal: AbortSignal.timeout(check.timeoutMs ?? 10_000),
  })
  if (response.status !== (check.status ?? 200)) {
    await response.body?.cancel()
    throw new Error(`Verification returned HTTP ${response.status}`)
  }
  if (check.contains === undefined) {
    await response.body?.cancel()
    return
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Verification response has no body')
  let text = ''
  const decoder = new TextDecoder()
  try {
    while (text.length < 65536) {
      const part = await reader.read()
      if (part.done) break
      text += decoder.decode(part.value, { stream: true })
      if (text.includes(check.contains)) return
    }
    throw new Error('Verification response did not match')
  } finally {
    await reader.cancel()
  }
}
