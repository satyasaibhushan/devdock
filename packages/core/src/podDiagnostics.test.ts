import { describe, expect, it } from 'vitest'
import {
  podSchedulingFailure,
  podTermination,
  terminationEvent,
  topProcessRss,
} from './podDiagnostics.js'

describe('pod diagnostics', () => {
  it('uses the eviction reason over stale ready container status', () => {
    expect(
      podTermination(
        'app-evicted',
        { phase: 'Failed', reason: 'Evicted', message: 'Node had\n memory pressure' },
        [{ name: 'php', ready: true }],
      ),
    ).toEqual({ pod: 'app-evicted', reason: 'Evicted', message: 'Node had memory pressure' })
  })

  it('extracts the most recent OOM termination from container history', () => {
    expect(
      podTermination('app-oom', { phase: 'Running' }, [
        {
          name: 'php',
          lastState: {
            terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: '2026-11-20T00:03:00Z' },
          },
        },
        {
          name: 'sidecar',
          lastState: {
            terminated: { reason: 'Error', exitCode: 1, finishedAt: '2026-11-20T00:01:00Z' },
          },
        },
      ]),
    ).toMatchObject({ pod: 'app-oom', container: 'php', reason: 'OOMKilled', exitCode: 137 })
  })

  it('recovers the latest eviction for a missing pod without attributing a sibling event', () => {
    const event = (name: string, reason: string, lastTimestamp: string) => ({
      reason,
      lastTimestamp,
      involvedObject: { name, kind: 'Pod' },
      message: 'memory',
    })
    expect(
      terminationEvent(
        [
          event('app-old', 'Evicted', '2026-11-20T00:01:00Z'),
          event('app-new', 'EvictionByEvictionAPI', '2026-11-20T00:02:00Z'),
          event('app-peer-pod', 'Evicted', '2026-11-20T00:03:00Z'),
        ],
        (name) => name === 'app-old' || name === 'app-new',
      ),
    ).toMatchObject({
      pod: 'app-new',
      reason: 'EvictionByEvictionAPI',
    })
  })

  it('keeps the scheduler condition message from a pending pod', () => {
    expect(
      podSchedulingFailure({
        conditions: [
          {
            type: 'PodScheduled',
            status: 'False',
            reason: 'Unschedulable',
            message: '0/2 nodes available: 2 Insufficient memory',
          },
        ],
      }),
    ).toBe('0/2 nodes available: 2 Insufficient memory')
  })

  it('reads the five largest RSS values, skipping processes whose status has no RSS', () => {
    const status = (pid: number, kiB?: number) =>
      `Name:\tpid-${pid}\nState:\tR (running)\nTgid:\t${pid}\nPid:\t${pid}\n${kiB ? `VmRSS:\t  ${kiB} kB\n` : ''}`
    const output = [
      status(1, 41),
      status(2),
      status(3, 4),
      status(4, 900),
      status(5, 64),
      status(6, 64),
      status(7, 82),
      status(8, 5),
    ].join('')
    expect(topProcessRss(output)).toEqual([
      { pid: 4, name: 'pid-4', rssKiB: 900 },
      { pid: 7, name: 'pid-7', rssKiB: 82 },
      { pid: 5, name: 'pid-5', rssKiB: 64 },
      { pid: 6, name: 'pid-6', rssKiB: 64 },
      { pid: 1, name: 'pid-1', rssKiB: 41 },
    ])
  })
})
