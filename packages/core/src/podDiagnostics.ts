import type { PodInfo, PodTermination, ProcessRss } from './types.js'

type Terminated = { reason?: string; message?: string; exitCode?: number; finishedAt?: string }
export type ContainerStatus = {
  name: string
  ready?: boolean
  imageID?: string
  restartCount?: number
  state?: { running?: object; waiting?: { reason?: string }; terminated?: Terminated }
  lastState?: { terminated?: Terminated }
}

function compact(message: unknown): string | undefined {
  return typeof message === 'string' ? message.trim().replace(/\s+/g, ' ') || undefined : undefined
}

export function podTermination(
  pod: string,
  status: Record<string, unknown>,
  containers: ContainerStatus[],
): PodTermination | undefined {
  const reason = compact(status.reason)
  if (reason && (status.phase === 'Failed' || EVICTION_REASONS.has(reason)))
    return { pod, reason, message: compact(status.message) }
  return latestTermination(
    containers.flatMap((container) => {
      const termination = container.state?.terminated ?? container.lastState?.terminated
      if (!termination || termination.exitCode === 0) return []
      return [
        {
          pod,
          container: container.name,
          reason: termination.reason ?? 'Terminated',
          message: compact(termination.message),
          exitCode: termination.exitCode,
          at: termination.finishedAt,
        },
      ]
    }),
  )
}

export function latestTermination(
  terminations: Array<PodTermination | undefined>,
): PodTermination | undefined {
  return terminations.reduce<PodTermination | undefined>((latest, incident) => {
    if (!incident) return latest
    if (!latest) return incident
    return (incident.at ?? '') >= (latest.at ?? '') ? incident : latest
  }, undefined)
}

export function podSchedulingFailure(status: Record<string, unknown>): string | undefined {
  if (!Array.isArray(status.conditions)) return
  const condition = status.conditions.find(
    (entry) =>
      entry?.type === 'PodScheduled' &&
      entry.status === 'False' &&
      entry.reason === 'Unschedulable',
  )
  return compact(condition?.message)
}

const EVICTION_REASONS = new Set([
  'Evicted',
  'EvictionByEvictionAPI',
  'NodeLost',
  'Shutdown',
  'Preempted',
  'OOMKilled',
])

export function terminationEvent(
  events: unknown[],
  belongsToWorkload: (pod: string) => boolean,
): PodTermination | undefined {
  return latestTermination(
    events.flatMap((item) => {
      const e = item as {
        reason?: string
        message?: string
        involvedObject?: { kind?: string; name?: string }
        eventTime?: string
        lastTimestamp?: string
        series?: { lastObservedTime?: string }
        metadata?: { creationTimestamp?: string }
      } | null
      const reason = e?.reason
      const pod = e?.involvedObject?.name
      if (
        !reason ||
        !EVICTION_REASONS.has(reason) ||
        e?.involvedObject?.kind !== 'Pod' ||
        !pod ||
        !belongsToWorkload(pod)
      )
        return []
      const at =
        e.series?.lastObservedTime ??
        e.lastTimestamp ??
        e.eventTime ??
        e.metadata?.creationTimestamp
      return [{ pod, reason, at, message: compact(e.message) }]
    }),
  )
}

/** The kernel comm name avoids returning credentials carried in process arguments. */
export function topProcessRss(output: string): ProcessRss[] {
  return output
    .split(/(?=^Name:\s)/m)
    .flatMap((status) => {
      const name = /^Name:[ \t]+([^\r\n]+)/m.exec(status)?.[1]?.trim()
      const pid = /^Pid:[ \t]+(\d+)\s*$/m.exec(status)?.[1]
      const rss = /^VmRSS:[ \t]+(\d+)[ \t]+kB\s*$/m.exec(status)?.[1]
      return name && pid && rss ? [{ pid: Number(pid), name, rssKiB: Number(rss) }] : []
    })
    .sort((a, b) => b.rssKiB - a.rssKiB || a.pid - b.pid)
    .slice(0, 5)
}

export function rssContainer(pod: PodInfo): string | undefined {
  const running = pod.containers?.filter(
    (container) => !container.init && (container.running || container.ready),
  )
  return (
    running?.find((container) => container.name === pod.logContainer)?.name ?? running?.[0]?.name
  )
}
