// stateStore — persists repos, last-known status, and terminal grants.
// JSON-backed to start (spec §11: "SQLite or JSON to start; don't overbuild").
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RepoStatus, TermMode } from './types.js'

/** A persisted read-write grant for a repo's terminal (spec §2, §8). */
export interface Grant {
  repo: string
  mode: TermMode
  /** epoch ms when the grant was issued. */
  issuedAt: number
}

interface Persisted {
  /** last-known status per repo id, keyed for fast lookup across restarts. */
  status: Record<string, RepoStatus>
  grants: Grant[]
  /** Optional per-repo command auto-run in the `devspace dev` session once its
   *  pod is up (e.g. the app's start script). Keyed by repo id. */
  startup: Record<string, string>
}

const EMPTY: Persisted = { status: {}, grants: [], startup: {} }

export class StateStore {
  private data: Persisted
  constructor(private readonly file: string) {
    this.data = StateStore.load(file)
  }

  private static load(file: string): Persisted {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Persisted>
      return {
        status: parsed.status ?? {},
        grants: parsed.grants ?? [],
        startup: parsed.startup ?? {},
      }
    } catch {
      return structuredClone(EMPTY)
    }
  }

  private flush(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }

  getStatus(repo: string): RepoStatus | undefined {
    return this.data.status[repo]
  }

  setStatus(repo: string, status: RepoStatus): void {
    this.data.status[repo] = status
    this.flush()
  }

  /** Replace the grant for a repo (one grant per repo). */
  setGrant(repo: string, mode: TermMode, issuedAt: number): void {
    this.data.grants = this.data.grants.filter((g) => g.repo !== repo)
    this.data.grants.push({ repo, mode, issuedAt })
    this.flush()
  }

  getGrant(repo: string): Grant | undefined {
    return this.data.grants.find((g) => g.repo === repo)
  }

  revokeGrant(repo: string): void {
    this.data.grants = this.data.grants.filter((g) => g.repo !== repo)
    this.flush()
  }

  getStartup(repo: string): string | undefined {
    return this.data.startup[repo]
  }

  /** Set (or, for an empty command, clear) the repo's startup command. */
  setStartup(repo: string, command: string): void {
    const trimmed = command.trim()
    if (trimmed) this.data.startup[repo] = trimmed
    else delete this.data.startup[repo]
    this.flush()
  }
}
