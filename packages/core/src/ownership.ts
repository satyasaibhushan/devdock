import { createHash } from 'node:crypto'
import type { RunResult } from './exec.js'
import type { Repo } from './types.js'

export type OwnershipRunner = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<RunResult>

/** A persistent claim, not a timeout lock. A sleeping laptop must not lose its deployment.
 * Kubernetes serializes create, so simultaneous claims cannot both succeed.
 * No credentials are stored in the ConfigMap. */
export class DeploymentOwnership {
  private snapshots = new Map<string, { expires: number; value: Promise<Record<string, string>> }>()

  /** Read claims without acquiring them. Cache and coalesce namespace reads for UI polling. */
  owners(namespace: string): Promise<Record<string, string>> {
    const cached = this.snapshots.get(namespace)
    if (cached && cached.expires > Date.now()) return cached.value
    const value = this.runner(
      'kubectl',
      [
        'get',
        'configmaps',
        '-n',
        namespace,
        '-o',
        'jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.data.deployment}{"\\t"}{.data.instance}{"\\n"}{end}',
      ],
      { timeoutMs: 10_000 },
    ).then((result) => {
      if (result.code !== 0) throw new Error('Ownership unavailable')
      const owners: Record<string, string> = {}
      for (const line of result.stdout.split('\n')) {
        const [name, deployment, instance] = line.split('\t')
        if (!deployment || !instance || !/^[0-9a-f-]{36}$/i.test(instance)) continue
        if (name === claimName(deployment)) owners[deployment] = instance
      }
      return owners
    })
    this.snapshots.set(namespace, { expires: Date.now() + 15_000, value })
    return value
  }

  constructor(
    private readonly instanceId: string,
    private readonly runner: OwnershipRunner,
  ) {}

  async claim(repo: Repo): Promise<void> {
    if (!repo.namespace) throw new Error('Deployment ownership requires an explicit namespace')
    const name = claimName(repo.name)
    const namespace = repo.namespace
    const read = () => this.read(repo.name, namespace)
    let result = await read()
    if (result.code !== 0)
      throw new Error(
        'Cannot verify deployment ownership. Check Kubernetes access and ConfigMap permissions.',
      )
    if (!result.stdout.trim()) {
      const created = await this.runner(
        'kubectl',
        [
          'create',
          'configmap',
          name,
          '-n',
          repo.namespace,
          `--from-literal=instance=${this.instanceId}`,
          `--from-literal=deployment=${repo.name}`,
        ],
        { timeoutMs: 15_000 },
      )
      if (created.code === 0) {
        this.snapshots.delete(repo.namespace)
        return
      }
      // A competing daemon may have won. Read authoritative ownership, never retry a write.
      result = await read()
    }
    if (result.code !== 0 || !result.stdout.trim())
      throw new Error('Cannot claim deployment ownership. Check ConfigMap create permissions.')
    const record = JSON.parse(result.stdout) as {
      data?: { instance?: string; deployment?: string }
    }
    if (record.data?.deployment !== repo.name || record.data.instance !== this.instanceId) {
      throw new Error(
        `Deployment ${repo.name} is owned by instance ${record.data?.instance ?? 'unknown'}. Operate on that instance. Disconnecting does not release ownership.`,
      )
    }
  }

  /** Give up this instance's claim so another instance can claim the deployment. */
  async release(repo: Repo): Promise<void> {
    await this.remove(repo, this.instanceId)
  }

  /** Move a claim held by `from` (an unreachable owner) to this instance. */
  async takeOver(repo: Repo, from: string): Promise<void> {
    await this.remove(repo, from)
    await this.claim(repo)
  }

  /** Delete the claim only while `holder` still holds it; never someone else's. */
  private async remove(repo: Repo, holder: string): Promise<void> {
    if (!repo.namespace) throw new Error('Deployment ownership requires an explicit namespace')
    const result = await this.read(repo.name, repo.namespace)
    if (result.code !== 0)
      throw new Error(
        'Cannot verify deployment ownership. Check Kubernetes access and ConfigMap permissions.',
      )
    if (!result.stdout.trim()) return
    const record = JSON.parse(result.stdout) as {
      data?: { instance?: string; deployment?: string }
    }
    if (record.data?.deployment !== repo.name || record.data.instance !== holder)
      throw new Error(
        `Deployment ${repo.name} is owned by instance ${record.data?.instance ?? 'unknown'}, not ${holder}.`,
      )
    const deleted = await this.runner(
      'kubectl',
      ['delete', 'configmap', claimName(repo.name), '-n', repo.namespace, '--ignore-not-found'],
      { timeoutMs: 15_000 },
    )
    if (deleted.code !== 0)
      throw new Error('Cannot release deployment ownership. Check ConfigMap delete permissions.')
    this.snapshots.delete(repo.namespace)
  }

  private read(deployment: string, namespace: string): Promise<RunResult> {
    return this.runner(
      'kubectl',
      [
        'get',
        'configmap',
        claimName(deployment),
        '-n',
        namespace,
        '--ignore-not-found',
        '-o',
        'json',
      ],
      { timeoutMs: 15_000 },
    )
  }
}

function claimName(deployment: string): string {
  return `devdock-owner-${createHash('sha256').update(deployment).digest('hex').slice(0, 32)}`
}
