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
