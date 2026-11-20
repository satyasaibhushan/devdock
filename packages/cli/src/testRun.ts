import { once } from 'node:events'
import { setTimeout } from 'node:timers/promises'
import type { CliRequest } from './cli.js'

type Stream = 'stdout' | 'stderr'
type Request = <T>(request: CliRequest) => Promise<T>
interface TestStatus {
  state: 'running' | 'finished' | 'failed' | 'interrupted'
  exitCode?: number
  error?: string
  cleanupError?: string
}

export async function followTest(request: Request, id: string, json: boolean): Promise<number> {
  const path = `/tests/${encodeURIComponent(id)}`
  const chunks: Record<Stream, Buffer[]> = { stdout: [], stderr: [] }
  const offsets: Record<Stream, number> = { stdout: 0, stderr: 0 }
  let status: TestStatus
  do {
    status = await request<TestStatus>({ method: 'GET', path })
    for (const stream of ['stdout', 'stderr'] as const) {
      while (true) {
        const page = await request<{ data: string; nextOffset: number; eof: boolean }>({
          method: 'GET',
          path: `${path}/output?stream=${stream}&offset=${offsets[stream]}`,
        })
        const bytes = Buffer.from(page.data, 'base64')
        if (bytes.length > 0) {
          offsets[stream] = page.nextOffset
          if (json) chunks[stream].push(bytes)
          else if (!process[stream].write(bytes)) await once(process[stream], 'drain')
        }
        if (page.eof || bytes.length === 0) break
      }
    }
    if (status.state === 'running') await setTimeout(500)
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
