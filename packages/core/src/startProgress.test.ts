import { describe, expect, it } from 'vitest'
import { parsePods } from './reconciler.js'
import { devSessionReady, initialSyncDone, startProgress } from './startProgress.js'

describe('dev start milestones', () => {
  it.each([
    'Initial sync completed',
    'Initial sync finished',
    'Successfully synced ./ with /app',
    '\u001b[32minfo Initial sync completed\u001b[0m',
  ])('recognizes %s', (line) => {
    expect(initialSyncDone([line])).toBe(true)
  })
  it.each([
    'Starting initial sync',
    'Waiting for initial sync',
    'Sync started on: ./ <-> /app',
    'Error syncing files',
  ])('does not report completion for %s', (line) => {
    expect(initialSyncDone([line])).toBe(false)
  })
  it('derives milestones from the existing pod status read, excluding old deployment pods', () => {
    const pods = parsePods(
      JSON.stringify({
        items: [
          {
            metadata: { name: 'app-old' },
            spec: { nodeName: 'node' },
            status: { containerStatuses: [{ ready: true, imageID: 'id' }] },
          },
          {
            metadata: { name: 'app-devspace-1' },
            spec: { nodeName: 'node' },
            status: { containerStatuses: [{ ready: false, imageID: 'id' }] },
          },
        ],
      }),
    )
    expect(startProgress(pods, [])).toEqual(['Pod scheduled', 'Image pulled'])
    expect(
      startProgress(
        pods.map((p) => ({ ...p, ready: true })),
        ['Successfully synced ./ with /app'],
      ),
    ).toEqual(['Pod scheduled', 'Image pulled', 'Containers ready', 'Initial file sync done'])
    expect(
      startProgress(
        pods.filter((p) => p.name === 'app-old'),
        [],
      ),
    ).toEqual([])
  })
})

describe('dev session readiness', () => {
  const pod = (name: string, ready: boolean) => ({ name, phase: 'Running', ready, restartCount: 0 })
  it('ignores the ready Helm pod while the DevSpace replacement is not ready', () => {
    expect(devSessionReady([pod('app-old', true)], false)).toBe(false)
    expect(devSessionReady([pod('app-old', true), pod('app-devspace-1', false)], false)).toBe(false)
  })
  it('is ready once every replacement pod is ready', () => {
    expect(devSessionReady([pod('app-old', true), pod('app-devspace-1', true)], false)).toBe(true)
  })
  it('falls back to the initial sync for configs that never replace their pod', () => {
    expect(devSessionReady([pod('app', true)], true)).toBe(true)
    expect(devSessionReady([pod('app', false)], true)).toBe(false)
    expect(devSessionReady([], true)).toBe(false)
  })
})
