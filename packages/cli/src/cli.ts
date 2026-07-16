// devdock CLI — the harness-side face of the daemon's agent-loop endpoints.
// Zero runtime dependencies (global fetch + node:util); response types are
// duplicated here (not imported from @devdock/core) to keep it that way.
//
// The point of this binary is EXIT CODES: a harness can background
// `devdock wait …` and be woken by process exit instead of polling —
// 0 = condition met, 2 = timeout, 1 = error (64 = usage).
import { parseArgs } from 'node:util'

export const DEFAULT_URL = 'http://127.0.0.1:7717'

export const USAGE = `devdock — command-line client for the devdock daemon (DEVDOCK_URL, default ${DEFAULT_URL})

Usage:
  devdock run  <repo> <command>   run a command in the workload's pod; exits with
                                  the command's REAL exit code (124 = timed out,
                                  125 = infra error: no pod / auth / connectivity)
      --workload <type>  --timeout-ms <n>  --json

  devdock wait <repo>             block until a condition holds; exit 0 = matched,
                                  2 = timeout, 1 = error
      --contains <substr>  --status <status>  --ready
      --source <auto|application|container|devdock>  --cursor <c>
      --workload <type>  --timeout-ms <n>  --json

  devdock logs <repo>             read logs; prints lines to stdout, the
                                  [source/cursor] header to stderr
      --source <auto|application|container|devdock>  --cursor <c>
      --tail <n>  --contains <substr>  --workload <type>  --json`

/** Thrown for bad invocations — the entry maps it to USAGE + exit 64. */
export class UsageError extends Error {}

export interface CliRequest {
  method: 'GET' | 'POST'
  path: string
  body?: Record<string, unknown>
}

export interface ParsedCli {
  command: 'run' | 'wait' | 'logs'
  request: CliRequest
  json: boolean
}

// Response shapes, mirroring @devdock/core (duplicated to stay dependency-free).
export interface RunResponse {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  pod?: string
  timedOut: boolean
  truncated: boolean
  infraError?: string
}

export interface WaitResponse {
  matched: boolean
  reason: 'contains' | 'status' | 'ready' | 'timeout'
  line?: string
  status?: string
  elapsedMs: number
  cursor?: string
}

export interface LogsResponse {
  source: string
  pod?: string
  lines: string[]
  cursor: string
  resync?: boolean
  dropped?: boolean
}

/** What the entry point does with a rendered result. */
export interface Rendered {
  out: string
  err: string
  code: number
}

function positiveInt(name: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a positive integer`)
  return n
}

const SOURCES = ['auto', 'application', 'container', 'devdock']

function checkSource(v: string | undefined): string | undefined {
  if (v !== undefined && !SOURCES.includes(v)) {
    throw new UsageError(`--source must be one of ${SOURCES.join(', ')}`)
  }
  return v
}

/** Drop undefined values so request bodies/queries stay minimal. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))
}

export function parseCli(argv: string[]): ParsedCli {
  const [command, ...rest] = argv
  if (command === 'run') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        workload: { type: 'string' },
        'timeout-ms': { type: 'string' },
        json: { type: 'boolean' },
      },
    })
    const [repo, ...cmd] = positionals
    if (!repo || cmd.length === 0) {
      throw new UsageError('run needs a repo and a command (quote it: devdock run api "pytest -q")')
    }
    return {
      command,
      json: values.json === true,
      request: {
        method: 'POST',
        path: `/repos/${encodeURIComponent(repo)}/run`,
        body: compact({
          command: cmd.join(' '),
          workload: values.workload,
          timeoutMs: positiveInt('timeout-ms', values['timeout-ms']),
        }),
      },
    }
  }

  if (command === 'wait') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        contains: { type: 'string' },
        status: { type: 'string' },
        ready: { type: 'boolean' },
        source: { type: 'string' },
        cursor: { type: 'string' },
        workload: { type: 'string' },
        'timeout-ms': { type: 'string' },
        json: { type: 'boolean' },
      },
    })
    const repo = positionals[0]
    if (!repo || positionals.length > 1) throw new UsageError('wait needs exactly one repo')
    if (!values.contains && !values.status && !values.ready) {
      throw new UsageError('wait needs at least one condition: --contains, --status, or --ready')
    }
    return {
      command,
      json: values.json === true,
      request: {
        method: 'POST',
        path: `/repos/${encodeURIComponent(repo)}/wait`,
        body: compact({
          contains: values.contains,
          status: values.status,
          ready: values.ready,
          source: checkSource(values.source),
          cursor: values.cursor,
          workload: values.workload,
          timeoutMs: positiveInt('timeout-ms', values['timeout-ms']),
        }),
      },
    }
  }

  if (command === 'logs') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        source: { type: 'string' },
        cursor: { type: 'string' },
        tail: { type: 'string' },
        contains: { type: 'string' },
        workload: { type: 'string' },
        json: { type: 'boolean' },
      },
    })
    const repo = positionals[0]
    if (!repo || positionals.length > 1) throw new UsageError('logs needs exactly one repo')
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(
      compact({
        source: checkSource(values.source),
        cursor: values.cursor,
        tail: positiveInt('tail', values.tail),
        contains: values.contains,
        workload: values.workload,
      }),
    )) {
      qs.set(k, String(v))
    }
    const q = qs.toString()
    return {
      command,
      json: values.json === true,
      request: {
        method: 'GET',
        path: `/repos/${encodeURIComponent(repo)}/logs/query${q ? `?${q}` : ''}`,
      },
    }
  }

  throw new UsageError(command ? `unknown command: ${command}` : 'no command given')
}

export function renderRun(r: RunResponse, json: boolean): Rendered {
  if (json) return { out: JSON.stringify(r), err: '', code: exitCodeForRun(r) }
  const notes = [
    r.infraError ? `devdock: infra error — ${r.infraError}` : '',
    r.timedOut ? 'devdock: command timed out — output is partial' : '',
    r.truncated ? 'devdock: output truncated to the tail' : '',
  ].filter(Boolean)
  return {
    out: r.stdout,
    err: [r.stderr, ...notes].filter(Boolean).join('\n'),
    code: exitCodeForRun(r),
  }
}

/** 124/125 follow the timeout(1)/docker convention: distinguishable from any
 *  plausible command exit so a harness never mistakes plumbing for a failure. */
function exitCodeForRun(r: RunResponse): number {
  if (r.infraError) return 125
  if (r.timedOut) return 124
  if (r.exitCode >= 0 && r.exitCode <= 255) return r.exitCode
  return 1
}

export function renderWait(r: WaitResponse, json: boolean): Rendered {
  const code = r.matched ? 0 : 2
  if (json) return { out: JSON.stringify(r), err: '', code }
  const line = r.matched
    ? `matched: ${r.reason}${r.line ? ` — ${r.line}` : ''}${r.status ? ` (status ${r.status})` : ''} after ${r.elapsedMs}ms`
    : `timeout after ${r.elapsedMs}ms${r.status ? ` (status ${r.status})` : ''}`
  return { out: line, err: r.cursor ? `cursor: ${r.cursor}` : '', code }
}

export function renderLogs(r: LogsResponse, json: boolean): Rendered {
  if (json) return { out: JSON.stringify(r), err: '', code: 0 }
  const flags = [r.resync ? 'resync' : '', r.dropped ? 'dropped' : ''].filter(Boolean)
  const head = `[source=${r.source}${r.pod ? ` pod=${r.pod}` : ''} cursor=${r.cursor}${
    flags.length ? ` ${flags.join(' ')}` : ''
  }]`
  return { out: r.lines.join('\n'), err: head, code: 0 }
}
