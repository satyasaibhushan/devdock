import { cleanLine } from './logTailer.js'
import type { PodInfo } from './types.js'

export function initialSyncDone(lines: string[]): boolean {
  return lines.some((line) =>
    /\b(?:initial sync (?:completed|finished|done)|successfully synced)\b/i.test(cleanLine(line)),
  )
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
