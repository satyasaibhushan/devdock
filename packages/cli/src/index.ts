#!/usr/bin/env node
// Entry point: parse → one HTTP call → print → exit. All logic that can be
// unit-tested lives in cli.ts; this file is the thin I/O shell around it.
import {
  type CliRequest,
  DEFAULT_URL,
  type LogsResponse,
  type RunResponse,
  USAGE,
  type WaitResponse,
  parseCli,
  renderLogs,
  renderRun,
  renderWait,
} from './cli.js'
import { followTest } from './testRun.js'

function emit(r: { out: string; err: string; code: number }): never {
  if (r.out) process.stdout.write(`${r.out}\n`)
  if (r.err) process.stderr.write(`${r.err}\n`)
  process.exit(r.code)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(`${USAGE}\n`)
    process.exit(argv.length === 0 ? 64 : 0)
  }

  let parsed: ReturnType<typeof parseCli>
  try {
    parsed = parseCli(argv)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`devdock: ${message}\n\n${USAGE}\n`)
    process.exit(64)
  }

  const base = (process.env.DEVDOCK_URL ?? DEFAULT_URL).replace(/\/$/, '')
  const request = async <T>(req: CliRequest): Promise<T> => {
    let res: Response
    try {
      res = await fetch(`${base}${req.path}`, {
        method: req.method,
        headers: req.body ? { 'content-type': 'application/json' } : undefined,
        body: req.body ? JSON.stringify(req.body) : undefined,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`cannot reach the daemon at ${base} — ${message}`)
    }
    const data = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
    return data
  }
  const data = await request<Record<string, unknown>>(parsed.request)
  if (parsed.command === 'test') {
    if (typeof data.id !== 'string') throw new Error('Daemon did not return a test run id')
    process.exitCode = await followTest(request, data.id, parsed.json)
    return
  }
  if (parsed.command === 'replica') {
    const out = parsed.json
      ? JSON.stringify(data)
      : typeof data.id === 'string'
        ? data.id
        : 'Route released'
    emit({ out, err: '', code: 0 })
  }
  if (parsed.command === 'run') emit(renderRun(data as unknown as RunResponse, parsed.json))
  if (parsed.command === 'wait') emit(renderWait(data as unknown as WaitResponse, parsed.json))
  emit(renderLogs(data as unknown as LogsResponse, parsed.json))
}

void main().catch((err) => {
  process.stderr.write(`devdock: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
