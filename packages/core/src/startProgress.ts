import { cleanLine } from './logTailer.js'
import type { PodInfo } from './types.js'

export function initialSyncDone(lines: string[]): boolean {
  return lines.some((line) =>
    /\b(?:initial sync (?:completed|finished|done)|successfully synced)\b/i.test(cleanLine(line)),
  )
}

/** Whether a just-started dev session is usable. Right after a deploy the Helm
 *  pod is already ready while DevSpace is still replacing it, so readiness must
 *  come from the replacement (`*-devspace`) pod. A config that never replaces
 *  its pod has no such pod; then the observed initial sync is the signal. */
export function devSessionReady(pods: PodInfo[], synced: boolean): boolean {
  const dev = pods.filter(isDevPod)
  if (dev.length > 0) return dev.every((p) => p.ready)
  return synced && pods.length > 0 && pods.every((p) => p.ready)
}

/** The pods a dev session runs in: the DevSpace replacements when there are
 *  any, otherwise (a config that never replaces) all of the workload's pods. */
export function devSessionPods(pods: PodInfo[]): PodInfo[] {
  const dev = pods.filter(isDevPod)
  return dev.length > 0 ? dev : pods
}

function isDevPod(pod: PodInfo): boolean {
  return pod.name.includes('-devspace')
}

export function startProgress(pods: PodInfo[], lines: string[]): string[] {
  // Ignore the old Helm pods while DevSpace is creating its replacement.
  const dev = pods.filter((p) => p.name.includes('-devspace'))
  const messages: string[] = []
  if (dev.length > 0 && dev.every((p) => p.scheduled === true)) messages.push('Pod scheduled')
  if (dev.length > 0 && dev.every((p) => p.imagePulled === true)) messages.push('Image pulled')
  if (dev.length > 0 && dev.every((p) => p.ready)) messages.push('Containers ready')
  if (initialSyncDone(lines)) messages.push('Initial file sync done')
  return messages
}
