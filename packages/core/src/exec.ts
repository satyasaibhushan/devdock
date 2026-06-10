// Thin promise wrapper around child_process — devdock shells out to
// trusted CLIs (devspace, kubectl, tmux) rather than reimplementing them.
import { type ChildProcess, spawn } from 'node:child_process'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  cwd?: string
  /** Kill the process after this many ms. */
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

/** Run a command to completion and capture its output. Never rejects — a
 *  non-zero exit (inspect `code`) and a missing binary (code 127, like a shell)
 *  are both reported in the result so one absent CLI can't crash the daemon. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env })
    let stdout = ''
    let stderr = ''
    let timer: NodeJS.Timeout | undefined

    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
    }

    child.stdout?.on('data', (d) => {
      stdout += d
    })
    child.stderr?.on('data', (d) => {
      stderr += d
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      const code = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : -1
      const hint = code === 127 ? `${cmd}: command not found` : err.message
      resolve({ code, stdout, stderr: stderr || hint })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** Spawn a long-lived streaming process (e.g. `kubectl logs -f`). Caller owns teardown. */
export function spawnStream(cmd: string, args: string[], opts: RunOptions = {}): ChildProcess {
  return spawn(cmd, args, { cwd: opts.cwd, env: opts.env })
}

/** Splits a chunked byte stream into lines, carrying partials across chunks. */
export class LineSplitter {
  private carry = ''
  constructor(private readonly emit: (line: string) => void) {}

  ingest(chunk: string): void {
    const text = this.carry + chunk
    const parts = text.split('\n')
    this.carry = parts.pop() ?? ''
    for (const line of parts) this.emit(line)
  }

  /** Emit any trailing partial line (call when the stream ends). */
  flush(): void {
    if (this.carry) {
      this.emit(this.carry)
      this.carry = ''
    }
  }
}

/** Like `run`, but also emits each output line (stdout + stderr interleaved)
 *  as it arrives — for surfacing long commands (devspace deploy/purge) live.
 *  Same never-rejects contract as `run`. */
export function runStream(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
  onLine: (line: string) => void = () => {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env })
    // One splitter per stream — sharing one would splice a partial stdout line
    // together with whatever stderr chunk lands next.
    const outLines = new LineSplitter(onLine)
    const errLines = new LineSplitter(onLine)
    const flush = () => {
      outLines.flush()
      errLines.flush()
    }
    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (d) => {
      stdout += d
      outLines.ingest(String(d))
    })
    child.stderr?.on('data', (d) => {
      stderr += d
      errLines.ingest(String(d))
    })
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : -1
      const hint = code === 127 ? `${cmd}: command not found` : err.message
      onLine(hint)
      flush()
      resolve({ code, stdout, stderr: stderr || hint })
    })
    child.on('close', (code) => {
      flush()
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}
