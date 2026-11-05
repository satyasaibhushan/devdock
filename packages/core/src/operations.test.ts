import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Operations } from './operations.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'operation-timings-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

it('keeps append-only timings past receipt retention and across restarts', () => {
  const file = join(dir, 'state.json.operations')
  let operations = new Operations(file, 'release-one')
  for (let i = 0; i < 105; i++) {
    const op = operations.create('svc', 'api', 'ns', 'start')
    operations.update(op.id, { state: 'succeeded' }, 'Completed')
  }
  expect(operations.list()).toHaveLength(100)
  const journal = `${file}.timings.jsonl`
  const prefix = readFileSync(journal, 'utf8')
  operations = new Operations(file, 'release-two')
  const op = operations.create('other', 'worker', 'ns', 'build')
  operations.update(op.id, { state: 'failed' }, 'private command output')
  operations.update(op.id, {}, 'later annotation')
  const content = readFileSync(journal, 'utf8')
  expect(content.startsWith(prefix)).toBe(true)
  const rows = content
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(rows).toHaveLength(106)
  expect(rows.at(-1)).toMatchObject({
    id: op.id,
    service: 'other',
    kind: 'build',
    release: 'release-two',
    state: 'failed',
  })
  expect(content).not.toContain('private command output')
  expect(statSync(journal).mode & 0o777).toBe(0o600)
})

it('records measured phase durations and leaves unobserved phases unknown', () => {
  vi.useFakeTimers()
  const file = join(dir, 'operations')
  const operations = new Operations(file)
  const op = operations.create('svc', '', 'ns', 'build_start')
  operations.observeLine(op.id, 'build:app Building image app')
  vi.advanceTimersByTime(100)
  operations.observeLine(op.id, 'deploy:app Deploying chart (app) with helm...')
  vi.advanceTimersByTime(200)
  operations.observeLine(op.id, 'deploy:app Deployed helm chart (Release revision: 1)')
  operations.phase(op.id, 'rollout', 'start')
  operations.phase(op.id, 'imagePull', 'start')
  vi.advanceTimersByTime(300)
  operations.phase(op.id, 'imagePull', 'end')
  vi.advanceTimersByTime(50)
  // A daemon restart retains in-progress phase clocks.
  const recovered = new Operations(file)
  recovered.update(op.id, { state: 'interrupted' }, 'Interrupted')
  expect(JSON.parse(readFileSync(`${file}.timings.jsonl`, 'utf8'))).toMatchObject({
    totalMs: 650,
    phasesMs: { build: 100, helm: 200, rollout: 350, imagePull: 300, ready: null },
  })
})

it('keeps the actual sandbox action distinct from its lifecycle receipt action', () => {
  const file = join(dir, 'operations')
  const operations = new Operations(file)
  const op = operations.create('sandbox:ticket', '', 'sb1', 'build', 'sleep')
  operations.update(op.id, { state: 'succeeded' })
  expect(operations.get(op.id).action).toBe('build')
  expect(JSON.parse(readFileSync(`${file}.timings.jsonl`, 'utf8')).kind).toBe('sleep')
})
