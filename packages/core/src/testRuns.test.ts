import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type RunOptions, type RunResult, run } from './exec.js'
import {
  LEGACY_TEST_BOOTSTRAP,
  resolveTestProfile,
  testCommand,
  testDockerfile,
} from './testProfiles.js'
import { type TestOutputStream, TestRuns } from './testRuns.js'
import type { Repo } from './types.js'

const success = (stdout = '') => ({ code: 0, stdout, stderr: '' })

describe('PHP test profiles', () => {
  it.each([
    { repo: 'cmc-student-view', constraint: '>=7.1', expected: 'php-7.1' },
    { repo: 'acs-jobs-management', constraint: '^8.1 || ^8.5', expected: 'php-8.1' },
    { repo: 'acs-jobs-management', constraint: '^8.5', expected: 'php-8.5' },
    { repo: 'upgraded-app', constraint: '~8.5.0', expected: 'php-8.5' },
    { repo: 'older-app', constraint: '8.1.*', expected: 'php-8.1' },
  ])('selects $expected for $repo', ({ repo, constraint, expected }) => {
    expect(resolveTestProfile(undefined, repo, constraint)).toBe(expected)
  })

  it('honors explicit profiles and rejects unknown or ambiguous choices', () => {
    expect(resolveTestProfile('php-8.5', 'acs-jobs-management', '^8.1')).toBe('php-8.5')
    expect(() => resolveTestProfile('php-7.2', 'cmc-student-view', '>=7.1')).toThrow(
      'Unknown PHP test profile',
    )
    expect(() => resolveTestProfile(undefined, 'app', '^8.2 || ^8.5')).toThrow(
      'Choose a PHP test profile',
    )
  })

  it('uses Composer 2.2 for legacy locks, independent test libraries, and both autoloaders', () => {
    const manifest = testDockerfile('php-7.1')
    expect(manifest).toContain('FROM composer:2.2 AS composer')
    expect(manifest).toContain('FROM php:7.1.33-cli-stretch')
    expect(manifest).toContain('phpunit/phpunit:6.5.14 mockery/mockery:0.9.11')
    expect(manifest).toContain('COPY bootstrap.php /opt/devtools/bootstrap.php')
    expect(manifest).toContain('--no-dev --no-plugins --no-scripts')
    expect(manifest).toContain('dump-autoload --dev')
    expect(LEGACY_TEST_BOOTSTRAP).toContain("require_once '/workspace/vendor/autoload.php'")
    expect(LEGACY_TEST_BOOTSTRAP).toContain("require_once '/opt/devtools/vendor/autoload.php'")
    expect(testCommand('php-7.1')).toContain('-d auto_prepend_file=/opt/devtools/bootstrap.php')
  })

  it.each(['php-8.1', 'php-8.5'] as const)(
    'builds %s with dev deps, SSH, and bounded Composer resources',
    (profile) => {
      const manifest = testDockerfile(profile)
      expect(manifest).toContain(`FROM php:${profile.slice(4)}-cli-bookworm`)
      expect(manifest).toContain('openssh-client')
      expect(manifest).toContain('memory_limit=512M')
      expect(manifest).toContain('docker-php-ext-enable apcu')
      expect(manifest).toContain('COMPOSER_MEMORY_LIMIT=1G')
      expect(manifest).toContain('COMPOSER_MAX_PARALLEL_HTTP=4 COMPOSER_MAX_PARALLEL_PROCESSES=4')
      expect(manifest).toContain('RUN --mount=type=ssh')
      expect(manifest).toContain('--no-plugins --no-scripts')
      expect(manifest).toContain('USER www-data')
      expect(manifest).toMatch(/^RUN --network=none .*memory\.max.*composer install/m)
      expect(manifest).not.toContain('--no-dev')
      expect(testCommand(profile)).toBe('php vendor/bin/phpunit')
    },
  )
})

describe('isolated test runs', () => {
  let tmp: string
  let repo: Repo
  let receipts: string
  const git = async (path: string, ...args: string[]) => {
    const result = await run('git', ['-C', path, ...args])
    if (result.code !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'devdock-test-run-'))
    const path = join(tmp, 'app')
    mkdirSync(path)
    await git(path, 'init', '-q')
    writeFileSync(join(path, 'composer.json'), '{"require":{"php":"^8.5"}}')
    writeFileSync(join(path, 'composer.lock'), '{}')
    writeFileSync(join(path, 'source.php'), 'committed')
    writeFileSync(join(path, '.gitignore'), '.env\n')
    await git(path, 'add', '.')
    await git(
      path,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      'Add test fixture',
    )
    repo = {
      id: 'app',
      name: 'app',
      path,
      configPath: join(path, 'devspace.yaml'),
      ports: [],
      session: 'devdock-app',
    }
    receipts = join(tmp, 'receipts')
    vi.stubEnv('DEVDOCK_TEST_SSH_AUTH_SOCK', '')
    vi.stubEnv('DEVDOCK_TEST_SSH_KNOWN_HOSTS', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(tmp, { recursive: true, force: true })
  })

  function dockerRunner(
    override: (
      args: string[],
      opts?: RunOptions,
    ) => RunResult | undefined | Promise<RunResult | undefined> = () => undefined,
    buildHelp = '      --resource stringArray     Resource limits for build containers',
  ) {
    return vi.fn(async (cmd: string, args: string[], opts?: RunOptions) => {
      if (cmd !== 'docker') return run(cmd, args, opts)
      if (args[0] === 'context') return success('fixture-engine\n')
      if (args[2] === 'build' && args[3] === '--help') return success(buildHelp)
      return (await override(args, opts)) ?? success()
    })
  }

  async function finished(runs: TestRuns, id: string) {
    return vi.waitFor(() => {
      const status = runs.status(id)
      if (!status || status.state === 'running') throw new Error('Test still active')
      return status
    })
  }

  function output(runs: TestRuns, id: string, stream: TestOutputStream) {
    const chunks: Buffer[] = []
    let offset = 0
    for (;;) {
      const page = runs.output(id, stream, offset)
      if (!page) throw new Error('Missing run output')
      chunks.push(Buffer.from(page.data, 'base64'))
      if (page.eof) return Buffer.concat(chunks).toString()
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset
    }
  }

  it('archives the selected ref, returns the actual exit, keeps complete paged streams, and cleans up', async () => {
    writeFileSync(join(repo.path, 'source.php'), 'dirty')
    const stdout = '👋'.repeat(19_000)
    const runner = dockerRunner((args, opts) => {
      if (args[2] === 'build') {
        expect(args).toEqual(
          expect.arrayContaining(['--resource=memory=2g', '--resource=memory-swap=2g']),
        )
        const context = args.at(-1) ?? ''
        expect(readFileSync(join(context, 'source/source.php'), 'utf8')).toBe('committed')
        expect(existsSync(join(context, 'source/.git'))).toBe(false)
        expect(readFileSync(join(context, 'Dockerfile'), 'utf8')).toContain(
          'FROM php:8.5-cli-bookworm',
        )
      }
      if (args[2] === 'run') {
        expect(args).toEqual(
          expect.arrayContaining([
            '--rm',
            '--network=none',
            '--cap-drop=ALL',
            '--cpus=2',
            '--memory=2g',
            '--pids-limit=256',
            'sh',
            '-c',
            'php vendor/bin/phpunit',
          ]),
        )
        if (!opts?.outputFiles) throw new Error('Missing log files')
        appendFileSync(opts.outputFiles.stdout, stdout)
        return { code: 7, stdout: '', stderr: 'suite stderr' }
      }
      if (args[2] === 'container')
        return {
          code: 1,
          stdout: '',
          stderr: 'Error response from daemon: No such container: test',
        }
    })
    const runs = new TestRuns(receipts, runner)
    const started = runs.start(repo, { ref: 'HEAD' })
    const status = await finished(runs, started.id)
    expect(status).toMatchObject({
      state: 'finished',
      profile: 'php-8.5',
      exitCode: 7,
      commit: await git(repo.path, 'rev-parse', 'HEAD'),
    })
    expect(status.cleanupError).toBeUndefined()
    expect(runner.mock.calls.map(([, args]) => args[2])).toContain('image')
    expect(existsSync(join(receipts, started.id, 'build'))).toBe(false)
    expect(output(runs, started.id, 'stdout')).toBe(stdout)
    expect(output(runs, started.id, 'stderr')).toBe('suite stderr')
    expect(readFileSync(join(repo.path, 'source.php'), 'utf8')).toBe('dirty')
    expect(new TestRuns(receipts).status(started.id)).toEqual(status)
  })

  it('copies tracked and unignored worktree changes, excludes ignored credentials, and scopes SSH to the build', async () => {
    const worktree = join(tmp, 'linked-worktree')
    await git(repo.path, 'worktree', 'add', '--detach', worktree, 'HEAD')
    writeFileSync(join(worktree, 'source.php'), 'worktree change')
    writeFileSync(join(worktree, 'extra.php'), 'untracked')
    writeFileSync(join(worktree, '.env'), 'not copied')
    vi.stubEnv('DEVDOCK_TEST_SSH_AUTH_SOCK', '/fixture/agent.sock')
    vi.stubEnv('DEVDOCK_TEST_SSH_KNOWN_HOSTS', '/fixture/known_hosts')
    const runner = dockerRunner((args) => {
      if (args[2] === 'build') {
        const context = args.at(-1) ?? ''
        expect(readFileSync(join(context, 'source/source.php'), 'utf8')).toBe('worktree change')
        expect(readFileSync(join(context, 'source/extra.php'), 'utf8')).toBe('untracked')
        expect(existsSync(join(context, 'source/.env'))).toBe(false)
        expect(existsSync(join(context, 'source/.git'))).toBe(false)
        expect(readFileSync(join(context, 'bootstrap.php'), 'utf8')).toBe(LEGACY_TEST_BOOTSTRAP)
        expect(args).toEqual(
          expect.arrayContaining([
            '--ssh',
            'default=/fixture/agent.sock',
            '--secret',
            'id=known_hosts,src=/fixture/known_hosts',
          ]),
        )
      }
      if (args[2] === 'run') {
        expect(args.at(-1)).toBe('php -v')
        expect(args).not.toContain('--ssh')
      }
    })
    const runs = new TestRuns(receipts, runner)
    const { id } = runs.start(repo, { worktree, profile: 'php-7.1', command: 'php -v' })
    expect(await finished(runs, id)).toMatchObject({
      state: 'finished',
      exitCode: 0,
      profile: 'php-7.1',
      worktree: realpathSync(worktree),
    })
  })

  it.each(['build failure', 'run timeout'] as const)(
    'cleans up and keeps diagnostics on %s',
    async (failure) => {
      const runner = dockerRunner((args) => {
        if (args[2] === 'build' && failure === 'build failure')
          return { code: 1, stdout: '', stderr: 'install failed' }
        if (args[2] === 'run')
          return { code: -1, stdout: 'partial stdout', stderr: '', timedOut: true }
      })
      const runs = new TestRuns(receipts, runner)
      const { id } = runs.start(repo, {})
      const didTimeout = failure === 'run timeout'
      expect(await finished(runs, id)).toMatchObject({
        state: 'failed',
        exitCode: didTimeout ? 124 : 125,
        error: didTimeout
          ? 'Test run exceeded its timeout'
          : expect.stringContaining('Test image build'),
      })
      const actions = runner.mock.calls
        .filter(
          ([cmd, args]) => cmd === 'docker' && args[0] === '--context' && args[3] !== '--help',
        )
        .map(([, args]) => args[2])
      expect(actions).toEqual(
        didTimeout ? ['build', 'run', 'container', 'image'] : ['build', 'container', 'image'],
      )
      expect(output(runs, id, didTimeout ? 'stdout' : 'stderr')).toBe(
        didTimeout ? 'partial stdout' : 'install failed',
      )
      expect(existsSync(join(receipts, id, 'build'))).toBe(false)
    },
  )

  it('reports an unsupported Docker builder without starting an uncapped build', async () => {
    const runner = dockerRunner(undefined, '      --memory bytes    Memory limit')
    const runs = new TestRuns(receipts, runner)
    const { id } = runs.start(repo, {})
    expect(await finished(runs, id)).toMatchObject({
      exitCode: 125,
      error: 'Test images require Docker Buildx with --resource memory limit support',
    })
    const calls = runner.mock.calls.filter(
      ([cmd, args]) => cmd === 'docker' && ['build', 'run'].includes(args[2] ?? ''),
    )
    expect(calls.map(([, args]) => args)).toEqual([
      ['--context', 'fixture-engine', 'build', '--help'],
    ])
    expect(existsSync(join(receipts, id, 'build'))).toBe(false)
  })

  it('rejects invalid inputs and worktrees from other repositories without using Docker', async () => {
    const other = join(tmp, 'other')
    mkdirSync(other)
    await git(other, 'init', '-q')
    const runner = dockerRunner()
    const runs = new TestRuns(receipts, runner)
    expect(() => runs.start(repo, { ref: 'HEAD', worktree: other })).toThrow(
      'Choose a git ref or a worktree',
    )
    expect(() => runs.start(repo, { timeoutMs: 3_600_001 })).toThrow('timeoutMs')
    expect(() => runs.start(repo, { profile: 'php-7.2' })).toThrow('Unknown PHP test profile')
    const { id } = runs.start(repo, { worktree: other })
    expect(await finished(runs, id)).toMatchObject({
      state: 'failed',
      error: 'The worktree must belong to the selected repo',
    })
    expect(runner.mock.calls.some(([cmd]) => cmd === 'docker')).toBe(false)
  })

  it('limits concurrent builds and releases the slot after cleanup', async () => {
    let resolveBuild: (result: RunResult) => void = () => {}
    const waiting = new Promise<RunResult>((resolve) => {
      resolveBuild = resolve
    })
    const runner = dockerRunner((args) => (args[2] === 'build' ? waiting : undefined))
    const runs = new TestRuns(receipts, runner)
    const first = runs.start(repo, {})
    const second = runs.start(repo, {})
    expect(() => runs.start(repo, {})).toThrow('Two isolated test runs')
    resolveBuild(success())
    await Promise.all([finished(runs, first.id), finished(runs, second.id)])
    expect(await finished(runs, runs.start(repo, {}).id)).toMatchObject({ exitCode: 0 })
  })

  it.each(['build', 'run'] as const)(
    'cancels an active Docker %s, removes its resources, and retries failed cleanup',
    async (phase) => {
      let started = false
      let removals = 0
      const runner = dockerRunner((args, opts) => {
        if (args[2] === phase) {
          started = true
          return run('sh', ['-c', 'sleep 60 & wait'], opts)
        }
        if (args[2] === 'container' && ++removals === 1)
          return { code: 1, stdout: '', stderr: 'Docker temporarily unavailable' }
      })
      const runs = new TestRuns(receipts, runner)
      const { id } = runs.start(repo, {})
      await vi.waitFor(() => expect(started).toBe(true))

      const [cancelled, duplicate] = await Promise.all([runs.cancel(id), runs.cancel(id)])
      expect(cancelled).toMatchObject({
        state: 'interrupted',
        exitCode: 130,
        cleanupError: 'Docker temporarily unavailable',
      })
      expect(duplicate).toEqual(cancelled)
      expect(removals).toBe(1)
      expect(existsSync(join(receipts, id, 'build'))).toBe(false)
      const commands = () => runner.mock.calls.filter(([cmd]) => cmd === 'docker').map(([, a]) => a)
      expect(commands()).toContainEqual([
        '--context',
        'fixture-engine',
        'container',
        'rm',
        '--force',
        '--volumes',
        `devdock-test-${id}`,
      ])
      expect(commands()).toContainEqual([
        '--context',
        'fixture-engine',
        'image',
        'rm',
        `devdock-test:${id}`,
      ])
      if (phase === 'build') expect(commands().some((args) => args[2] === 'run')).toBe(false)
      await vi.waitFor(() => expect(runs.status(id)?.cleanupError).toBeUndefined(), {
        timeout: 3_000,
      })
      expect(removals).toBe(2)
      expect(await runs.cancel(id)).toMatchObject({ state: 'interrupted', exitCode: 130 })
      expect(await runs.cancel('unknown')).toBeUndefined()
    },
  )

  it('marks a crashed run interrupted and cleans up its recorded Docker context', async () => {
    const id = '9bd4c6d7-95c1-45c2-8c63-08a698317641'
    mkdirSync(join(receipts, id, 'build'), { recursive: true })
    writeFileSync(
      join(receipts, id, 'run.json'),
      JSON.stringify({
        id,
        repo: 'app',
        state: 'running',
        startedAt: 1,
        context: 'old-context',
      }),
    )
    writeFileSync(join(receipts, id, 'stdout'), 'before crash')
    const runner = dockerRunner()
    const runs = new TestRuns(receipts, runner)
    await runs.recover()
    expect(runs.status(id)).toMatchObject({ state: 'interrupted', exitCode: 125 })
    expect(runner.mock.calls).toEqual([
      [
        'docker',
        [
          '--context',
          'old-context',
          'container',
          'rm',
          '--force',
          '--volumes',
          `devdock-test-${id}`,
        ],
        { timeoutMs: 15_000, killProcessGroup: true },
      ],
      [
        'docker',
        ['--context', 'old-context', 'image', 'rm', `devdock-test:${id}`],
        { timeoutMs: 15_000, killProcessGroup: true },
      ],
    ])
    expect(output(runs, id, 'stdout')).toBe('before crash')
    expect(existsSync(join(receipts, id, 'build'))).toBe(false)
  })
})
