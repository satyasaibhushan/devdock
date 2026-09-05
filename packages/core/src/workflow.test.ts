import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Operations } from './operations.js'
import { checkPrerequisites, loadWorkflowConfig, verifyEndpoint } from './workflow.js'

const directories: string[] = []
function file() {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-test-'))
  directories.push(dir)
  return join(dir, 'workflow.json')
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('machine prerequisites', () => {
  it('loads machine-local commands and fails closed on malformed configuration', () => {
    const path = file()
    expect(loadWorkflowConfig(path).prerequisites).toEqual([])
    writeFileSync(
      path,
      JSON.stringify({
        prerequisites: [{ id: 'vpn', label: 'VPN', command: ['check-vpn'], actions: ['start'] }],
      }),
    )
    expect(loadWorkflowConfig(path).prerequisites[0]?.command).toEqual(['check-vpn'])
    writeFileSync(path, '{bad')
    expect(() => loadWorkflowConfig(path)).toThrow('Cannot read')
    writeFileSync(path, JSON.stringify({ prerequisites: [{ id: 'vpn', command: 'sh do-things' }] }))
    expect(() => loadWorkflowConfig(path)).toThrow('Invalid')
  })
  it('runs only applicable commands, preserving machine context but never returning output', async () => {
    const runner = vi.fn(async () => ({
      code: 1,
      stdout: 'private-output',
      stderr: 'private-error',
    }))
    const checks = [
      { id: 'vpn', label: 'VPN', command: ['vpn-check', '--quiet'], actions: ['start' as const] },
    ]
    expect(await checkPrerequisites(checks, 'destroy', '/repo', {}, runner)).toEqual([])
    const results = await checkPrerequisites(
      checks,
      'start',
      '/repo',
      { DEVDOCK_NAMESPACE: 'mine' },
      runner,
    )
    expect(results).toEqual([{ id: 'vpn', label: 'VPN', status: 'failed', detail: 'Exit 1' }])
    expect(runner).toHaveBeenCalledWith(
      'vpn-check',
      ['--quiet'],
      expect.objectContaining({
        cwd: '/repo',
        timeoutMs: 10000,
        env: { DEVDOCK_NAMESPACE: 'mine' },
      }),
    )
    expect(JSON.stringify(results)).not.toContain('private')
  })
  it.each([2, 126, 127, -1])(
    'reports exit %s as unknown, not a negative prerequisite',
    async (code) => {
      const results = await checkPrerequisites(
        [{ id: 'tool', label: 'Tool', command: ['probe'] }],
        'start',
        '/',
        {},
        async () => ({ code, stdout: '', stderr: '' }),
      )
      expect(results[0]?.status).toBe('unknown')
    },
  )
  it('reports timeouts as unknown even with exit zero', async () => {
    const results = await checkPrerequisites(
      [{ id: 'tool', label: 'Tool', command: ['probe'] }],
      'build',
      '/',
      {},
      async () => ({ code: 0, timedOut: true, stdout: '', stderr: '' }),
    )
    expect(results[0]).toMatchObject({ status: 'unknown', detail: 'Timed out' })
  })
})

describe('operation receipts', () => {
  it('deduplicates active requests, isolates workloads and rejects conflicting actions', () => {
    const ops = new Operations(file())
    const first = ops.create('accounts', 'api', 'mine', 'build')
    expect(ops.create('accounts', 'api', 'mine', 'build').id).toBe(first.id)
    expect(() => ops.create('accounts', 'api', 'mine', 'restart')).toThrow('active operation')
    expect(() => ops.create('accounts', 'api', 'other', 'build')).toThrow('active operation')
    expect(ops.create('accounts', 'worker', 'mine', 'build').id).not.toBe(first.id)
  })
  it('keeps ID, stage and activity after restart and allows a new completed run', () => {
    const path = file()
    const ops = new Operations(path)
    const op = ops.create('accounts', 'api', 'mine', 'start')
    ops.update(op.id, { stage: 'waiting' }, 'Waiting for readiness')
    const restarted = new Operations(path)
    expect(restarted.get(op.id)).toMatchObject({
      stage: 'waiting',
      state: 'active',
      logs: [{ message: 'Waiting for readiness' }],
    })
    restarted.update(op.id, { state: 'succeeded' }, 'Completed')
    expect(restarted.create('accounts', 'api', 'mine', 'start').id).not.toBe(op.id)
  })
  it('refuses to silently discard corrupt operation history', () => {
    const path = file()
    writeFileSync(path, 'bad')
    expect(() => new Operations(path)).toThrow('refusing to lose active work')
  })
})

describe('endpoint verification', () => {
  it('requires both status and expected text without exposing the response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('healthy', { status: 200 })),
    )
    await expect(
      verifyEndpoint({ url: 'https://example.invalid/health', contains: 'healthy' }),
    ).resolves.toBeUndefined()
    await expect(
      verifyEndpoint({ url: 'https://example.invalid/health', contains: 'missing' }),
    ).rejects.toThrow('did not match')
    expect(fetch).toHaveBeenCalledWith(
      'https://example.invalid/health',
      expect.objectContaining({ redirect: 'error' }),
    )
  })
  it('does not accept a successful connection with an error HTTP response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('private body', { status: 503 })),
    )
    await expect(verifyEndpoint({ url: 'https://example.invalid/health' })).rejects.toThrow(
      'HTTP 503',
    )
  })
})
