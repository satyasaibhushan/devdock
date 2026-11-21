import { once } from 'node:events'
import { setTimeout } from 'node:timers/promises'
import type { CliRequest } from './cli.js'

type Stream = 'stdout' | 'stderr'
type Request = <T>(request: CliRequest, signal?: AbortSignal) => Promise<T>
interface TestStatus {
  state: 'running' | 'finished' | 'failed' | 'interrupted'
  exitCode?: number
  error?: string
  cleanupError?: string
}

export async function runTest(request: Request, start: CliRequest, json: boolean): Promise<number> {
  const controller = new AbortController()
  const interrupt = () => controller.abort(130)
  const terminate = () => controller.abort(143)
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    // Keep the start request alive through an interrupt so we get the id to cancel.
    const data = await request<{ id?: unknown }>(start)
    if (typeof data.id !== 'string') throw new Error('Daemon did not return a test run id')
    const id = data.id
    try {
      return await followTest(request, id, json, controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) throw error
      try {
        const status = await request<TestStatus>(
          { method: 'POST', path: `/tests/${encodeURIComponent(id)}/cancel` },
          AbortSignal.timeout(40_000),
        )
        if (status.cleanupError)
          process.stderr.write(`devdock test ${id} cleanup will retry: ${status.cleanupError}\n`)
      } catch (error) {
        process.stderr.write(`devdock test ${id}: cancellation failed: ${String(error)}\n`)
      }
      return controller.signal.reason as number
    }
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
}

async function followTest(
  request: Request,
  id: string,
  json: boolean,
  signal: AbortSignal,
): Promise<number> {
  const path = `/tests/${encodeURIComponent(id)}`
  const chunks: Record<Stream, Buffer[]> = { stdout: [], stderr: [] }
  const offsets: Record<Stream, number> = { stdout: 0, stderr: 0 }
  let status: TestStatus
  do {
    signal.throwIfAborted()
    status = await request<TestStatus>({ method: 'GET', path }, signal)
    for (const stream of ['stdout', 'stderr'] as const) {
      while (true) {
        const page = await request<{ data: string; nextOffset: number; eof: boolean }>(
          {
            method: 'GET',
            path: `${path}/output?stream=${stream}&offset=${offsets[stream]}`,
          },
          signal,
        )
        const bytes = Buffer.from(page.data, 'base64')
        if (bytes.length > 0) {
          offsets[stream] = page.nextOffset
          if (json) chunks[stream].push(bytes)
          else if (!process[stream].write(bytes)) await once(process[stream], 'drain', { signal })
        }
        if (page.eof || bytes.length === 0) break
      }
    }
    if (status.state === 'running') await setTimeout(500, undefined, { signal })
  } while (status.state === 'running')
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        ...status,
        stdout: Buffer.concat(chunks.stdout).toString(),
        stderr: Buffer.concat(chunks.stderr).toString(),
      })}\n`,
    )
  } else {
    if (status.error) process.stderr.write(`devdock test ${id}: ${status.error}\n`)
    if (status.cleanupError)
      process.stderr.write(`devdock test ${id} cleanup: ${status.cleanupError}\n`)
  }
  return status.exitCode ?? 125
}
