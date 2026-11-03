import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Repo } from './types.js'

/** Check presence only: configuration values never enter logs or API results. */
export function environmentWarning(repo: Repo): string | undefined {
  const root = repo.root ?? repo.path
  if (!['.env.example', '.env.docker'].some((name) => existsSync(join(root, name)))) return
  try {
    if (statSync(join(root, '.env')).isFile()) return
  } catch {
    // Missing or unreadable configuration deserves the same preflight warning.
  }
  return 'Checkout has an environment template but no regular .env file. Run the repository sync-env workflow before testing; a successful build does not prove runtime configuration is present.'
}
