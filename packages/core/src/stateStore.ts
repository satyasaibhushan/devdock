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

/** A replica: an ephemeral branch-pinned parallel deployment living in a git
 *  worktree under the parent repo. The record — not the filesystem scanner —
 *  is the source of truth for materializing the replica's Repo on rescan
 *  (scanning the worktree would re-register the parent's own configs). */
export interface ReplicaRecord {
  /** Repo id, `<parentId>-rN`. */
  id: string
  parentId: string
  /** Branch the worktree was created from (checkout is detached at its tip). */
  branch: string
  /** Absolute path to the worktree. */
  path: string
  /** epoch ms — replicas older than the TTL are garbage-collected. */
  createdAt: number
  /** The generated per-workload devspace.yaml paths — the only configs the
   *  replica materializes from. */
  configPaths: string[]
  namespace?: string
  /** Helm release names to uninstall on delete. Older records lack this and
   *  fall back to deriving names from configPaths. */
  releases?: string[]
  /** The replica builds its own image from its branch (deploy-then-dev)
   *  instead of reusing the parent's. */
  ownImage?: boolean
  /** Whether the URL alias Ingress has been applied (retried each pass until
   *  it sticks). */
  ingressApplied?: boolean
  ingressName?: string
}

interface Persisted {
  /** last-known status per repo id, keyed for fast lookup across restarts. */
  status: Record<string, RepoStatus>
  grants: Grant[]
  /** Startup commands by repo and pod type. A string is the legacy per-repo
   *  shape and applies to every type until the first type-specific edit. */
  startup: Record<string, string | Record<string, string>>
  /** Startup commands queued by a start whose dev pod isn't ready yet, keyed by
   *  workload key. Persisted because the ready-wait spans a whole devspace
   *  deploy (minutes) — a daemon restart or crash inside that window must not
   *  eat the queued command. Cleared when it fires or the workload stops. */
  pendingStartup: Record<string, string>
  /** Every namespace devdock has seen or the user has switched to — the
   *  selector's options, since listing cluster namespaces is RBAC-forbidden. */
  namespaces: string[]
  /** The namespace each dev session was started in, keyed by workload key.
   *  Repos with no config-declared namespace inherit the kube context's, so
   *  this pins a running session to where it actually lives — switching the
   *  global namespace must not make its pods "disappear". Survives daemon
   *  restarts because the tmux sessions do too. */
  sessionNamespaces: Record<string, string>
  /** Replica records by id — the durable source replicas re-materialize from. */
  replicas: Record<string, ReplicaRecord>
}

const EMPTY: Persisted = {
  status: {},
  grants: [],
  startup: {},
  pendingStartup: {},
  namespaces: [],
  sessionNamespaces: {},
  replicas: {},
}

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
        pendingStartup: parsed.pendingStartup ?? {},
        namespaces: parsed.namespaces ?? [],
        sessionNamespaces: parsed.sessionNamespaces ?? {},
        replicas: parsed.replicas ?? {},
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

  getStartup(repo: string, podType: string): string | undefined {
    const value = this.data.startup[repo]
    return typeof value === 'string' ? value : value?.[podType]
  }

  /** Return the resolved command for every pod type. Legacy commands are
   *  expanded in-memory so clients see the behavior they already had. */
  getStartupCommands(repo: string, podTypes: string[]): Record<string, string> {
    const value = this.data.startup[repo]
    if (typeof value === 'string') {
      return Object.fromEntries(podTypes.map((type) => [type, value]))
    }
    return Object.fromEntries(podTypes.map((type) => [type, value?.[type] ?? '']))
  }

  /** Set (or, for an empty command, clear) one pod type's startup command.
   *  Editing a legacy per-repo command first expands it across known types. */
  setStartup(repo: string, podType: string, command: string, podTypes: string[]): void {
    const current = this.data.startup[repo]
    const commands =
      typeof current === 'string'
        ? Object.fromEntries(podTypes.map((type) => [type, current]))
        : { ...current }
    const trimmed = command.trim()
    if (trimmed) commands[podType] = trimmed
    else delete commands[podType]
    if (Object.keys(commands).length) this.data.startup[repo] = commands
    else delete this.data.startup[repo]
    this.flush()
  }

  getPendingStartup(key: string): string | undefined {
    return this.data.pendingStartup[key]
  }

  /** Queue (or, with undefined, clear) a workload's startup command awaiting a
   *  ready dev pod. */
  setPendingStartup(key: string, command: string | undefined): void {
    if (command) this.data.pendingStartup[key] = command
    else delete this.data.pendingStartup[key]
    this.flush()
  }

  /** Namespaces devdock knows about (insertion order), for the selector. */
  getNamespaces(): string[] {
    return [...this.data.namespaces]
  }

  /** Learn a namespace the user switched to or devdock observed. */
  rememberNamespace(ns: string): void {
    const trimmed = ns.trim()
    if (!trimmed || this.data.namespaces.includes(trimmed)) return
    this.data.namespaces.push(trimmed)
    this.flush()
  }

  getSessionNamespace(key: string): string | undefined {
    return this.data.sessionNamespaces[key]
  }

  /** Pin (or, with undefined, unpin) the namespace a workload's dev session
   *  runs in. */
  setSessionNamespace(key: string, ns: string | undefined): void {
    if (ns) this.data.sessionNamespaces[key] = ns
    else delete this.data.sessionNamespaces[key]
    this.flush()
  }

  listReplicas(): ReplicaRecord[] {
    return Object.values(this.data.replicas)
  }

  getReplica(id: string): ReplicaRecord | undefined {
    return this.data.replicas[id]
  }

  addReplica(record: ReplicaRecord): void {
    this.data.replicas[record.id] = record
    this.flush()
  }

  /** Merge changes into an existing record; a no-op for unknown ids. */
  updateReplica(id: string, patch: Partial<Omit<ReplicaRecord, 'id'>>): void {
    const current = this.data.replicas[id]
    if (!current) return
    this.data.replicas[id] = { ...current, ...patch }
    this.flush()
  }

  removeReplica(id: string): void {
    delete this.data.replicas[id]
    this.flush()
  }

  /** Copy the parent's startup commands to a new replica id, so an inherited
   *  `python main.py` fires on the replica's first start too. */
  copyStartup(fromRepo: string, toRepo: string): void {
    const value = this.data.startup[fromRepo]
    if (value === undefined) return
    this.data.startup[toRepo] = typeof value === 'string' ? value : { ...value }
    this.flush()
  }

  /** Drop every startup command stored for a repo id (replica deletion). */
  clearStartup(repo: string): void {
    if (!(repo in this.data.startup)) return
    delete this.data.startup[repo]
    this.flush()
  }
}
