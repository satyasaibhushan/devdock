import { describe, expect, it } from 'vitest'
import { UsageError, parseCli, renderLogs, renderRun, renderWait } from './cli.js'

describe('parseCli', () => {
  it('run: repo + quoted command → POST /run with the body', () => {
    const p = parseCli(['run', 'svc-a', 'pytest -q', '--workload', 'api', '--timeout-ms', '60000'])
    expect(p.command).toBe('run')
    expect(p.request).toEqual({
      method: 'POST',
      path: '/repos/svc-a/run',
      body: { command: 'pytest -q', workload: 'api', timeoutMs: 60_000 },
    })
  })

  it('run: multiple positionals are joined into one command', () => {
    const p = parseCli(['run', 'svc-a', 'echo', 'hello'])
    expect(p.request.body?.command).toBe('echo hello')
  })

  it('wait: builds the condition body and requires at least one condition', () => {
    const p = parseCli(['wait', 'svc-a', '--contains', 'Uvicorn running', '--timeout-ms', '90000'])
    expect(p.request).toEqual({
      method: 'POST',
      path: '/repos/svc-a/wait',
      body: { contains: 'Uvicorn running', timeoutMs: 90_000 },
    })
    expect(() => parseCli(['wait', 'svc-a'])).toThrow(UsageError)
  })

  it('logs: builds the query string', () => {
    const p = parseCli([
      'logs',
      'svc-a',
      '--source',
      'application',
      '--cursor',
      'f:1:42',
      '--tail',
      '100',
    ])
    expect(p.request.method).toBe('GET')
    expect(p.request.path).toBe(
      '/repos/svc-a/logs/query?source=application&cursor=f%3A1%3A42&tail=100',
    )
  })

  it('rejects unknown commands, bad sources, and bad numbers', () => {
    expect(() => parseCli(['frobnicate'])).toThrow(UsageError)
    expect(() => parseCli([])).toThrow(UsageError)
    expect(() => parseCli(['logs', 'svc-a', '--source', 'nope'])).toThrow(UsageError)
    expect(() => parseCli(['wait', 'svc-a', '--ready', '--timeout-ms', 'soon'])).toThrow(UsageError)
    expect(() => parseCli(['run', 'svc-a'])).toThrow(UsageError)
  })
})

describe('renderRun', () => {
  const base = {
    ok: true,
    exitCode: 0,
    stdout: 'out',
    stderr: '',
    timedOut: false,
    truncated: false,
  }

  it('exit code mirrors the remote command', () => {
    expect(renderRun({ ...base }, false).code).toBe(0)
    expect(renderRun({ ...base, ok: false, exitCode: 2 }, false).code).toBe(2)
    expect(renderRun({ ...base, ok: false, exitCode: -1 }, false).code).toBe(1)
  })

  it('124 on timeout, 125 on infra error — never confusable with a test failure', () => {
    expect(renderRun({ ...base, ok: false, timedOut: true }, false).code).toBe(124)
    const infra = renderRun({ ...base, ok: false, infraError: 'no running pod' }, false)
    expect(infra.code).toBe(125)
    expect(infra.err).toContain('infra error')
  })

  it('stdout goes to out, stderr + notes to err', () => {
    const r = renderRun({ ...base, stderr: 'warn', truncated: true }, false)
    expect(r.out).toBe('out')
    expect(r.err).toContain('warn')
    expect(r.err).toContain('truncated')
  })

  it('--json emits the raw response', () => {
    const r = renderRun({ ...base }, true)
    expect(JSON.parse(r.out)).toMatchObject({ exitCode: 0 })
  })
})

describe('renderWait', () => {
  it('0 when matched, 2 on timeout', () => {
    const hit = renderWait(
      { matched: true, reason: 'contains', line: 'ready', elapsedMs: 900, cursor: 'f:1:9' },
      false,
    )
    expect(hit.code).toBe(0)
    expect(hit.out).toContain('matched: contains — ready')
    expect(hit.err).toBe('cursor: f:1:9')

    const miss = renderWait(
      { matched: false, reason: 'timeout', status: 'CRASHED', elapsedMs: 30_000 },
      false,
    )
    expect(miss.code).toBe(2)
    expect(miss.out).toContain('timeout after 30000ms (status CRASHED)')
  })
})

describe('renderLogs', () => {
  it('lines to stdout, header (with flags) to stderr', () => {
    const r = renderLogs(
      { source: 'application', lines: ['a', 'b'], cursor: 'f:1:4', dropped: true },
      false,
    )
    expect(r.code).toBe(0)
    expect(r.out).toBe('a\nb')
    expect(r.err).toBe('[source=application cursor=f:1:4 dropped]')
  })
})
