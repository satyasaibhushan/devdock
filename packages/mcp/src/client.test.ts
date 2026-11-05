import { expect, it } from 'vitest'
import { daemonRequestTimeoutMs } from './client.js'

it.each([
  ['/repos/svc/run', { timeoutMs: 600_000 }, 610_000],
  ['/instances/box/api/repos/svc/run?workload=api', { timeoutMs: 240_000 }, 250_000],
  ['/terminals/svc:t1/run', { timeoutMs: 600_000 }, 610_000],
  ['/repos/svc/wait', { timeoutMs: 300_000 }, 310_000],
  ['/repos/svc/run', { timeoutMs: 1e9 }, 610_000],
  ['/repos/svc/wait', { timeoutMs: 1e9 }, 310_000],
  ['/repos/svc/run', undefined, 180_000],
  ['/repos/svc/run', { timeoutMs: -1 }, 180_000],
  ['/repos/svc/run', { timeoutMs: '600000' }, 180_000],
  ['/repos/svc/operations', { timeoutMs: 600_000 }, 180_000],
])('keeps %s responses within the bounded request budget', (path, body, expected) => {
  expect(daemonRequestTimeoutMs(path, body)).toBe(expected)
})
