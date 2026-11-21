import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { type RunOptions, type RunResult, loginShell, loginShellArgs, run } from './exec.js'
import { shellQuote } from './supervisor.js'
import {
  LEGACY_TEST_BOOTSTRAP,
  type PhpTestProfile,
  resolveTestProfile,
  testCommand,
  testDockerfile,
} from './testProfiles.js'
import type { Repo } from './types.js'

const MAX_TIMEOUT_MS = 60 * 60_000
const DEFAULT_TIMEOUT_MS = 15 * 60_000
const MAX_CONCURRENT_RUNS = 2
const OUTPUT_BYTES = 32 * 1024
const CLEANUP_RETRY_MS = 1_000
const MAX_CLEANUP_RETRY_MS = 30_000

export interface TestRunOptions {
  ref?: string
  worktree?: string
  profile?: string
  command?: string
  timeoutMs?: number
}

export interface TestRun {
  id: string
  repo: string
  state: 'running' | 'finished' | 'failed' | 'interrupted'
  profile?: PhpTestProfile
  commit?: string
  worktree?: string
  startedAt: number
  finishedAt?: number
  exitCode?: number
  error?: string
  cleanupError?: string
}

interface Receipt extends TestRun {
  context?: string
  dockerLoginShell?: boolean
}

interface ActiveRun {
  controller: AbortController
  done: Promise<void>
}

export type TestOutputStream = 'stdout' | 'stderr'

export interface TestOutput {
  data: string
  nextOffset: number
  eof: boolean
}

const runName = (id: string) => `devdock-test-${id}`
const imageName = (id: string) => `devdock-test:${id}`

export class TestRunInputError extends Error {}
export class TestRunBusyError extends Error {}

export class TestRuns {
  private readonly active = new Map<string, ActiveRun>()
  private readonly cleaning = new Map<string, Promise<void>>()
  private readonly retrying = new Set<string>()

  constructor(
    private readonly directory: string,
    private readonly runner: typeof run = run,
  ) {}

  start(repo: Repo, options: TestRunOptions): TestRun {
    if (repo.parentId) throw new TestRunInputError('Choose the source repo and a ref or worktree')
    const { ref, worktree, command, profile, timeoutMs = DEFAULT_TIMEOUT_MS } = options
    if (ref !== undefined && worktree !== undefined)
      throw new TestRunInputError('Choose a git ref or a worktree')
    if (ref !== undefined && (typeof ref !== 'string' || !ref.trim()))
      throw new TestRunInputError('ref must be a non-empty git ref')
    if (worktree !== undefined && (typeof worktree !== 'string' || !isAbsolute(worktree)))
      throw new TestRunInputError('worktree must be an absolute path on the daemon host')
    if (
      command !== undefined &&
      (typeof command !== 'string' || !command.trim() || command.length > 8192)
    )
      throw new TestRunInputError('command must be non-empty and at most 8192 characters')
    if (profile !== undefined) {
      try {
        resolveTestProfile(profile, repo.id, undefined)
      } catch (error) {
        throw new TestRunInputError(error instanceof Error ? error.message : String(error))
      }
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS)
      throw new TestRunInputError(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`)
    if (this.active.size >= MAX_CONCURRENT_RUNS)
      throw new TestRunBusyError('Two isolated test runs are already active on this daemon')

    const record: Receipt = {
      id: randomUUID(),
      repo: repo.id,
      state: 'running',
      startedAt: Date.now(),
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    mkdirSync(this.path(record.id), { mode: 0o700 })
    this.save(record)
    const controller = new AbortController()
    const done = this.execute(repo, { ...options, timeoutMs }, record, controller.signal).finally(
      () => this.active.delete(record.id),
    )
    this.active.set(record.id, { controller, done })
    void done.catch((error: unknown) => this.reportError(record.id, error))
    return { ...record }
  }

  async cancel(id: string): Promise<TestRun | undefined> {
    const active = this.active.get(id)
    if (active) {
      active.controller.abort()
      await active.done
    } else {
      const record = this.read(id)
      if (record?.state === 'running') await this.recoverRun(record)
    }
    return this.status(id)
  }

  status(id: string): TestRun | undefined {
    const receipt = this.read(id)
    if (!receipt) return undefined
    const { context: _context, dockerLoginShell: _shell, ...status } = receipt
    return status
  }

  output(id: string, stream: TestOutputStream, offset: number): TestOutput | undefined {
    const run = this.read(id)
    if (!run) return undefined
    const buffer = Buffer.alloc(OUTPUT_BYTES)
    let count = 0
    try {
      const fd = openSync(this.path(id, stream), 'r')
      try {
        count = readSync(fd, buffer, 0, buffer.length, offset)
      } finally {
        closeSync(fd)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return {
      data: buffer.subarray(0, count).toString('base64'),
      nextOffset: offset + count,
      eof: run.state !== 'running' && count < buffer.length,
    }
  }

  async recover(): Promise<void> {
    if (!existsSync(this.directory)) return
    for (const id of readdirSync(this.directory)) {
      if (this.active.has(id) || this.retrying.has(id)) continue
      const record = this.read(id)
      if (!record || (record.state !== 'running' && !record.cleanupError)) continue
      await this.recoverRun(record)
    }
  }

  private recoverRun(record: Receipt): Promise<void> {
    if (record.state === 'running') {
      record.state = 'interrupted'
      record.exitCode = 125
      record.error = 'Daemon restarted during the test run'
    }
    return this.cleanUp(record)
  }

  private async execute(
    repo: Repo,
    options: TestRunOptions & { timeoutMs: number },
    record: Receipt,
    signal: AbortSignal,
  ): Promise<void> {
    const contextDir = this.path(record.id, 'build')
    const source = join(contextDir, 'source')
    const deadline = record.startedAt + options.timeoutMs
    const remaining = () => {
      signal.throwIfAborted()
      const left = deadline - Date.now()
      if (left <= 0) throw new TestTimeout()
      return left
    }
    const runOptions = () => ({ timeoutMs: remaining(), killProcessGroup: true, signal })
    try {
      mkdirSync(source, { recursive: true })
      if (options.worktree)
        record.worktree = await this.snapshotWorktree(repo, options.worktree, source, runOptions)
      else record.commit = await this.snapshotRef(repo, options.ref ?? 'HEAD', source, runOptions)

      for (const file of ['composer.json', 'composer.lock']) {
        if (!lstatSync(join(source, file), { throwIfNoEntry: false })?.isFile())
          throw new Error(`The test source needs a regular ${file} file`)
      }
      const composer = JSON.parse(readFileSync(join(source, 'composer.json'), 'utf8')) as {
        require?: { php?: string }
      }
      const profile = resolveTestProfile(options.profile, repo.id, composer.require?.php)
      record.profile = profile
      writeFileSync(join(contextDir, 'Dockerfile'), testDockerfile(profile))
      if (profile === 'php-7.1')
        writeFileSync(join(contextDir, 'bootstrap.php'), LEGACY_TEST_BOOTSTRAP)
      const discovery = ['context', 'show']
      let context = await this.runner('docker', discovery, runOptions())
      if (context.code === 127) {
        record.dockerLoginShell = true
        context = await this.runDocker(record, discovery, runOptions())
      }
      if (context.timedOut) throw new TestTimeout()
      if (context.code !== 0)
        throw new Error(context.stderr.trim() || 'Cannot determine Docker context')
      record.context = context.stdout.trim().split(/\r?\n/).at(-1)
      if (!record.context) throw new Error('Cannot determine Docker context')
      this.save(record)

      const build = await this.docker(
        record,
        ['build', '--progress=plain', '--tag', imageName(record.id), ...sshArgs(), contextDir],
        runOptions(),
      )
      if (build.timedOut || Date.now() >= deadline) throw new TestTimeout()
      if (build.code !== 0)
        throw new Error(`Test image build exited ${build.code}. See stderr for build output`)

      const result = await this.docker(
        record,
        [
          'run',
          '--rm',
          '--pull=never',
          '--name',
          runName(record.id),
          '--label',
          `devdock.test-run=${record.id}`,
          '--network=none',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--init',
          '--cpus=2',
          '--memory=2g',
          '--pids-limit=256',
          imageName(record.id),
          'timeout',
          '--kill-after=10s',
          `${Math.ceil(remaining() / 1000)}s`,
          'sh',
          '-c',
          options.command ?? testCommand(profile),
        ],
        runOptions(),
      )
      signal.throwIfAborted()
      if (result.timedOut) throw new TestTimeout()
      record.state = 'finished'
      record.exitCode = result.code < 0 ? 125 : result.code
    } catch (error) {
      if (signal.aborted) {
        record.state = 'interrupted'
        record.exitCode = 130
        record.error = 'Test run cancelled'
      } else {
        record.state = 'failed'
        record.exitCode = error instanceof TestTimeout || Date.now() >= deadline ? 124 : 125
        record.error = error instanceof Error ? error.message : String(error)
      }
    } finally {
      // Docker may finish an already accepted create or export after the client exits.
      await this.cleanUp(record, record.state === 'interrupted' && !!record.context)
    }
  }

  private async snapshotRef(
    repo: Repo,
    ref: string,
    source: string,
    options: () => RunOptions,
  ): Promise<string> {
    const git = ['-C', repo.root ?? repo.path]
    const commit = (
      await this.checked(
        'git',
        [...git, 'rev-parse', '--verify', '--end-of-options', `${ref.trim()}^{commit}`],
        options(),
      )
    ).trim()
    if (!/^[a-f0-9]{40,64}$/.test(commit))
      throw new Error('Git did not resolve the test ref to a commit')
    const archive = join(dirname(source), 'source.tar')
    await this.checked('git', [...git, 'archive', `--output=${archive}`, commit], options())
    await this.checked('tar', ['-xf', archive, '-C', source], options())
    rmSync(archive)
    return commit
  }

  private async snapshotWorktree(
    repo: Repo,
    path: string,
    source: string,
    options: () => RunOptions,
  ): Promise<string> {
    const worktree = realpathSync(path)
    const git = ['-C', worktree]
    const top = (
      await this.checked('git', [...git, 'rev-parse', '--show-toplevel'], options())
    ).trim()
    if (realpathSync(top) !== worktree) throw new Error('Provide the root of the git worktree')
    const commonDir = async (directory: string) =>
      realpathSync(
        (
          await this.checked(
            'git',
            ['-C', directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
            options(),
          )
        ).trim(),
      )
    if ((await commonDir(worktree)) !== (await commonDir(repo.root ?? repo.path)))
      throw new Error('The worktree must belong to the selected repo')
    const paths = await this.checked(
      'git',
      [...git, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      options(),
    )
    for (const path of new Set(paths.split('\0').filter(Boolean))) {
      options()
      const input = join(worktree, path)
      if (!existsSync(dirname(input))) continue
      const pathToParent = relative(worktree, realpathSync(dirname(input)))
      if (pathToParent === '..' || pathToParent.startsWith(`..${sep}`) || isAbsolute(pathToParent))
        throw new Error(`Worktree path escapes its root: ${path}`)
      let stat: ReturnType<typeof lstatSync>
      try {
        stat = lstatSync(input)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue // tracked deletion
        throw error
      }
      if (!stat.isFile() && !stat.isSymbolicLink())
        throw new Error(`Unsupported worktree entry: ${path}`)
      const output = join(source, path)
      mkdirSync(dirname(output), { recursive: true })
      if (stat.isSymbolicLink()) symlinkSync(readlinkSync(input), output)
      else copyFileSync(input, output)
    }
    return worktree
  }

  private async checked(command: string, args: string[], options: RunOptions): Promise<string> {
    const result = await this.runner(command, args, options)
    if (result.timedOut) throw new TestTimeout()
    if (result.code !== 0)
      throw new Error(result.stderr.trim() || `${command} exited ${result.code}`)
    return result.stdout
  }

  private async docker(record: Receipt, args: string[], options: RunOptions): Promise<RunResult> {
    const outputFiles = {
      stdout: this.path(record.id, 'stdout'),
      stderr: this.path(record.id, 'stderr'),
    }
    if (!record.context) throw new Error('Test run has no Docker context')
    const result = await this.runDocker(record, ['--context', record.context, ...args], {
      ...options,
      outputFiles,
    })
    // Spawn errors are returned by the runner even when child output goes to disk.
    if (result.stdout) appendFileSync(outputFiles.stdout, result.stdout, { mode: 0o600 })
    if (result.stderr) appendFileSync(outputFiles.stderr, result.stderr, { mode: 0o600 })
    return result
  }

  private runDocker(record: Receipt, args: string[], options: RunOptions): Promise<RunResult> {
    return record.dockerLoginShell
      ? this.runner(
          loginShell,
          [loginShellArgs, `exec docker ${args.map(shellQuote).join(' ')}`],
          options,
        )
      : this.runner('docker', args, options)
  }

  private cleanUp(record: Receipt, recheck = false, retryMs = CLEANUP_RETRY_MS): Promise<void> {
    const pending = this.cleaning.get(record.id)
    if (pending) return pending
    const task = this.cleanup(record)
      .then((error) => {
        record.cleanupError = error
        record.finishedAt ??= Date.now()
        this.save(record)
        if (!error && !recheck) return
        this.retrying.add(record.id)
        setTimeout(() => {
          this.retrying.delete(record.id)
          void this.cleanUp(record, false, Math.min(retryMs * 2, MAX_CLEANUP_RETRY_MS)).catch(
            (err: unknown) => this.reportError(record.id, err),
          )
        }, retryMs).unref()
      })
      .finally(() => this.cleaning.delete(record.id))
    this.cleaning.set(record.id, task)
    return task
  }

  private reportError(id: string, error: unknown): void {
    console.error(`Cannot persist isolated test run ${id}: ${String(error)}`)
  }

  private async cleanup(record: Receipt): Promise<string | undefined> {
    const failures: string[] = []
    try {
      rmSync(this.path(record.id, 'build'), { recursive: true, force: true })
    } catch (error) {
      failures.push(String(error))
    }
    if (record.context) {
      for (const [kind, ...args] of [
        ['container', 'rm', '--force', '--volumes', runName(record.id)],
        ['image', 'rm', imageName(record.id)],
      ] as const) {
        try {
          const result = await this.runDocker(
            record,
            ['--context', record.context, kind, ...args],
            {
              timeoutMs: 15_000,
              killProcessGroup: true,
            },
          )
          if (result.code !== 0 && !new RegExp(`No such ${kind}:`, 'i').test(result.stderr))
            failures.push(result.stderr.trim() || `Docker ${kind} cleanup failed`)
        } catch (error) {
          failures.push(String(error))
        }
      }
    }
    return failures.length ? failures.join('\n') : undefined
  }

  private path(id: string, file = ''): string {
    return join(this.directory, id, file)
  }

  private read(id: string): Receipt | undefined {
    if (!/^[a-f0-9-]{36}$/.test(id)) return undefined
    try {
      return JSON.parse(readFileSync(this.path(id, 'run.json'), 'utf8')) as Receipt
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private save(record: Receipt): void {
    const temp = this.path(record.id, 'run.tmp')
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600 })
    renameSync(temp, this.path(record.id, 'run.json'))
  }
}

class TestTimeout extends Error {
  constructor() {
    super('Test run exceeded its timeout')
  }
}

function sshArgs(): string[] {
  const agent = process.env.DEVDOCK_TEST_SSH_AUTH_SOCK
  const knownHosts = process.env.DEVDOCK_TEST_SSH_KNOWN_HOSTS
  if (!agent && !knownHosts) return []
  if (!agent || !knownHosts)
    throw new Error('Set both DEVDOCK_TEST_SSH_AUTH_SOCK and DEVDOCK_TEST_SSH_KNOWN_HOSTS')
  return ['--ssh', `default=${agent}`, '--secret', `id=known_hosts,src=${knownHosts}`]
}
