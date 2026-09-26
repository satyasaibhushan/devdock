// Startup commands are per machine. Copy them to the machine a deployment
// moves to, and between machines when they link, so a first start there runs
// the same command. A command the receiving machine already has is its own
// choice and is never overwritten.

import type { InstanceCall } from './move.js'

interface RepoStartup {
  repo: { id: string }
  startupCommands?: Record<string, string>
}

async function startupOn(call: InstanceCall, instance: string): Promise<Map<string, RepoStartup>> {
  const result = await call(instance, 'GET', '/repos')
  if (result.status !== 200 || !Array.isArray(result.body))
    throw new Error('Cannot read startup commands')
  return new Map((result.body as RepoStartup[]).map((state) => [state.repo.id, state]))
}

export interface CopiedStartup {
  repo: string
  podType: string
}

/** Give `to` the startup commands it lacks from `from`, for repos checked out
 *  on both, optionally only one repo. Returns what was copied. */
export async function copyStartupCommands(
  call: InstanceCall,
  from: string,
  to: string,
  repo?: string,
): Promise<CopiedStartup[]> {
  const [source, target] = await Promise.all([startupOn(call, from), startupOn(call, to)])
  const copied: CopiedStartup[] = []
  for (const [id, state] of source) {
    if (repo !== undefined && id !== repo) continue
    const existing = target.get(id)
    if (!existing) continue
    for (const [podType, command] of Object.entries(state.startupCommands ?? {})) {
      if (!command.trim() || existing.startupCommands?.[podType]?.trim()) continue
      // The target may not offer this pod type; its checkout decides.
      const result = await call(to, 'PUT', `/repos/${encodeURIComponent(id)}/startup`, {
        command,
        workload: podType,
      }).catch(() => undefined)
      if (result?.status === 200) copied.push({ repo: id, podType })
    }
  }
  return copied
}
