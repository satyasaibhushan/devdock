import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DeploymentOwnership } from './ownership.js'
import type { Repo } from './types.js'

const repo = { name: 'accounts-api', namespace: 'sai' } as Repo

function cluster() {
  const records = new Map<string, { instance: string; deployment: string }>()
  const runner = vi.fn(async (_cmd: string, args: string[]) => {
    const key = `${args[2]}:${args[args.indexOf('-n') + 1]}`
    if (args[0] === 'get')
      return {
        code: 0,
        stdout: records.has(key) ? JSON.stringify({ data: records.get(key) }) : '',
        stderr: '',
      }
    if (records.has(key)) return { code: 1, stdout: '', stderr: 'AlreadyExists' }
    records.set(key, {
      instance:
        args
          .find((a) => a.startsWith('--from-literal=instance='))
          ?.split('=')
          .at(-1) ?? '',
      deployment: repo.name,
    })
    return { code: 0, stdout: '', stderr: '' }
  })
  return { records, runner }
}

describe('deployment ownership', () => {
  it('reads and coalesces claims without writes or unrelated ConfigMap values', async () => {
    const id = '7d2af2da-9d8f-4790-92a5-46e9b7cf965c'
    const name = `devdock-owner-${createHash('sha256').update(repo.name).digest('hex').slice(0, 32)}`
    const runner = vi.fn(async () => ({
      code: 0,
      stdout: `${name}\t${repo.name}\t${id}\nother\tother\t${id}\n`,
      stderr: '',
    }))
    const ownership = new DeploymentOwnership(id, runner)
    const [first, second] = await Promise.all([ownership.owners('sai'), ownership.owners('sai')])
    expect(first).toEqual({ [repo.name]: id })
    expect(second).toEqual(first)
    expect(runner).toHaveBeenCalledTimes(1)
  })
  it('does not interpret unavailable ownership as unclaimed', async () => {
    const ownership = new DeploymentOwnership('mac', async () => ({
      code: 1,
      stdout: '',
      stderr: 'Forbidden',
    }))
    await expect(ownership.owners('sai')).rejects.toThrow('Ownership unavailable')
  })
  it('allows one winner in a concurrent claim and preserves it after restart', async () => {
    const { runner } = cluster()
    const results = await Promise.allSettled([
      new DeploymentOwnership('mac', runner).claim(repo),
      new DeploymentOwnership('devbox', runner).claim(repo),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    await expect(new DeploymentOwnership('mac', runner).claim(repo)).resolves.toBeUndefined()
    await expect(new DeploymentOwnership('devbox', runner).claim(repo)).rejects.toThrow(
      'owned by instance mac',
    )
  })
  it('does not write when authoritative ownership cannot be read', async () => {
    const runner = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'network unavailable' }))
    await expect(new DeploymentOwnership('mac', runner).claim(repo)).rejects.toThrow(
      'Cannot verify',
    )
    expect(runner).toHaveBeenCalledTimes(1)
  })
  it('separates namespaces and refuses implicit namespace', async () => {
    const { runner } = cluster()
    await new DeploymentOwnership('mac', runner).claim(repo)
    await expect(
      new DeploymentOwnership('devbox', runner).claim({ ...repo, namespace: 'other' }),
    ).resolves.toBeUndefined()
    await expect(
      new DeploymentOwnership('mac', runner).claim({ ...repo, namespace: undefined }),
    ).rejects.toThrow('explicit namespace')
  })
  it('fails closed on denied creates or malformed owner records', async () => {
    const denied = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
    denied.mockResolvedValueOnce({ code: 0, stdout: '{}', stderr: '' })
    await expect(new DeploymentOwnership('mac', denied).claim(repo)).rejects.toThrow(
      'owned by instance unknown',
    )
  })
})
