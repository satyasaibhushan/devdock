import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { Repo } from './types.js'

export function workloadConfigPath(repo: Repo): string {
  const id = createHash('sha256').update(repo.name).digest('hex').slice(0, 16)
  return join(dirname(repo.configPath), `.devdock-${id}.yaml`)
}

/** DevSpace keys its local cache by config filename, independently of project
 * name. Keep a symlink beside the original so relative imports and paths retain
 * their meaning, and config edits remain visible without copying configuration. */
export function prepareWorkloadConfig(repo: Repo): void {
  if (!repo.devspaceTemplateName) return
  const alias = workloadConfigPath(repo)
  const target = basename(repo.configPath)
  try {
    symlinkSync(target, alias)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (readlinkSync(alias) !== target)
      throw new Error(`Refusing to replace workload config ${alias}`)
  }

  // Local generated aliases must not appear as source changes, including in
  // worktrees. Git resolves the correct per-repository exclude path for us.
  let exclude: string
  try {
    exclude = resolve(
      repo.path,
      execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
        cwd: repo.path,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    )
  } catch {
    return
  }
  const rule = '.devdock-*.yaml'
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  if (current.split(/\r?\n/).includes(rule)) return
  mkdirSync(dirname(exclude), { recursive: true })
  appendFileSync(exclude, `\n${rule}\n`)
}
