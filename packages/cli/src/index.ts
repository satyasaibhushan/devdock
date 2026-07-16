#!/usr/bin/env node
// Entry point: parse → one HTTP call → print → exit. All logic that can be
// unit-tested lives in cli.ts; this file is the thin I/O shell around it.
import {
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

function emit(r: { out: string; err: string; code: number }): never {
  if (r.out) process.stdout.write(`${r.out}\n`)
  if (r.err) process.stderr.write(`${r.err}\n`)
  process.exit(r.code)
}

async function main(): Promise<never> {
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
  let res: Response
  try {
    res = await fetch(`${base}${parsed.request.path}`, {
      method: parsed.request.method,
      headers: parsed.request.body ? { 'content-type': 'application/json' } : undefined,
      body: parsed.request.body ? JSON.stringify(parsed.request.body) : undefined,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`devdock: cannot reach the daemon at ${base} — ${message}\n`)
    process.exit(1)
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    process.stderr.write(`devdock: ${(data.error as string) ?? `HTTP ${res.status}`}\n`)
    process.exit(1)
  }

  if (parsed.command === 'run') emit(renderRun(data as unknown as RunResponse, parsed.json))
  if (parsed.command === 'wait') emit(renderWait(data as unknown as WaitResponse, parsed.json))
  emit(renderLogs(data as unknown as LogsResponse, parsed.json))
}

void main().catch((err) => {
  process.stderr.write(`devdock: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
