import { describe, expect, it } from 'vitest'
import { parsePods } from './reconciler.js'
import { initialSyncDone, startProgress } from './startProgress.js'

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
