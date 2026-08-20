// registry — discover DevSpace-enabled repos (spec §12).
// Scans configured roots for devspace.yaml and parses workload, namespace, ports.
import { type Dirent, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Repo } from './types.js'

const IGNORE_DIRS = new Set(['node_modules', '.git', '.venv', 'dist', 'build', 'vendor'])
const CONFIG_NAME = 'devspace.yaml'

/** tmux session name devdock uses for a repo (spec §5). */
export function sessionName(id: string): string {
  return `devdock-${id}`
}

/** The question var whose options name a repo's deployable workloads. An org
 *  convention (every multi-workload config uses it), not a per-repo hardcode. */
const WORKLOAD_VAR = 'WORKLOAD_TYPE'

/** Parse the relevant fields out of a devspace.yaml string. Pure + testable. */
export function parseDevspaceConfig(yamlText: string): {
  name?: string
  namespace?: string
  workload?: string
  ports: number[]
  varDefaults: Record<string, string>
  /** WORKLOAD_TYPE options, when it's a question var offering a real choice. */
  workloads?: string[]
  /** WORKLOAD_TYPE default (the workload acted on when none is chosen). */
  defaultWorkload?: string
  /** WORKLOAD_TYPE as a plain scalar var (e.g. `api`) — the case where each
   *  workload is its own `.devspace/<name>-<type>/` config rather than one
   *  config with a question var. */
  workloadType?: string
} {
  let doc: unknown
  try {
    doc = parseYaml(yamlText)
  } catch {
    return { ports: [], varDefaults: {} }
  }
  if (doc === null || typeof doc !== 'object') return { ports: [], varDefaults: {} }
  const d = doc as Record<string, unknown>

  const name = typeof d.name === 'string' ? d.name : undefined
  const deployments = asRecord(d.deployments)
  const dev = asRecord(d.dev)

  // `question:` vars stop devspace for interactive input. Capture each one's
  // declared default (or first option when there is no default) so verbs can
  // answer it via --var. Plain-value vars never prompt and need nothing.
  const varDefaults: Record<string, string> = {}
  let workloads: string[] | undefined
  let defaultWorkload: string | undefined
  let workloadType: string | undefined
  for (const [key, value] of Object.entries(asRecord(d.vars) ?? {})) {
    // A plain `WORKLOAD_TYPE: api` scalar marks a single-workload service config
    // (one per `.devspace/<name>-<type>/`); the base groups siblings by it.
    if (key === WORKLOAD_VAR && typeof value === 'string') workloadType = value
    const entry = asRecord(value)
    if (!entry || !('question' in entry)) continue
    const options = Array.isArray(entry.options) ? entry.options : []
    const answer = entry.default ?? options[0]
    if (typeof answer === 'string' || typeof answer === 'number' || typeof answer === 'boolean') {
      varDefaults[key] = String(answer)
    }
    // WORKLOAD_TYPE's options are the repo's deployable workloads — what the
    // detail-pane selector offers. Keep them in declared order.
    if (key === WORKLOAD_VAR) {
      const types = options.filter((o): o is string => typeof o === 'string')
      if (types.length) {
        workloads = types
        defaultWorkload = typeof answer === 'string' ? answer : types[0]
      }
    }
  }

  // workload: first deployment, else first dev target.
  const workload = firstKey(deployments) ?? firstKey(dev)

  // namespace: top-level, or a deployment's kubectl/helm namespace.
  let namespace = typeof d.namespace === 'string' ? d.namespace : undefined

  const ports = new Set<number>()
  for (const target of Object.values(dev ?? {})) {
    const t = asRecord(target)
    if (!t) continue
    if (!namespace && typeof t.namespace === 'string') namespace = t.namespace
    collectPorts(t.ports, ports)
    collectPorts(t.forward, ports)
  }

  return {
    name,
    namespace,
    workload,
    ports: [...ports].sort((a, b) => a - b),
    varDefaults,
    workloads,
    defaultWorkload,
    workloadType,
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function firstKey(r: Record<string, unknown> | undefined): string | undefined {
  if (!r) return undefined
  for (const k of Object.keys(r)) return k
  return undefined
}

function collectPorts(v: unknown, out: Set<number>): void {
  if (!Array.isArray(v)) return
  for (const entry of v) {
    const e = asRecord(entry)
    const raw = e?.port
    // devspace port mappings look like "8080:80" or 8080.
    const local = typeof raw === 'string' ? raw.split(':')[0] : raw
    const n = Number(local)
    if (Number.isFinite(n) && n > 0) out.add(n)
  }
}

/** Recursively find devspace.yaml paths under a root, skipping noisy dirs. */
function findConfigs(root: string, depth: number, out: string[]): void {
  if (depth < 0) return
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isFile() && e.name === CONFIG_NAME) out.push(join(root, e.name))
    else if (e.isDirectory() && e.name === '.devspace') findServiceConfigs(join(root, e.name), out)
    else if (e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.'))
      findConfigs(join(root, e.name), depth - 1, out)
  }
}

/**
 * Multi-service repos keep one config per service at .devspace/<service>/devspace.yaml
 * (the `./devspace` wrapper pattern); each service is its own repo entry whose
 * path is the service dir, so devspace commands run where the wrapper would run
 * them. Only exact <service>/devspace.yaml children count — everything else in
 * .devspace/ is devspace's own cache and is ignored.
 */
function findServiceConfigs(devspaceDir: string, out: string[]): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(devspaceDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const cfg = join(devspaceDir, e.name, CONFIG_NAME)
    try {
      statSync(cfg)
      out.push(cfg)
    } catch {
      /* not a service dir */
    }
  }
}

export interface ScanOptions {
  /** Roots to scan. Defaults to ~/Code. */
  roots?: string[]
  /** Max directory depth to recurse. */
  maxDepth?: number
}

/** Scan the filesystem and build the repo registry. */
export function scanRepos(opts: ScanOptions = {}): Repo[] {
  const roots = opts.roots ?? [join(homedir(), 'Code')]
  const maxDepth = opts.maxDepth ?? 4
  const configs: string[] = []
  for (const root of roots) findConfigs(root, maxDepth, configs)

  const repos: Repo[] = []
  const seen = new Set<string>()
  for (const configPath of configs) {
    // repo root is the dir holding devspace.yaml (or its parent if under .devspace/).
    let repoPath = dirname(configPath)
    if (basename(repoPath) === '.devspace') repoPath = dirname(repoPath)
    if (seen.has(repoPath)) continue
    seen.add(repoPath)

    // Multi-service repos keep configs at .devspace/<service>/devspace.yaml and
    // are driven by a `./devspace` wrapper that runs devspace from the repo root
    // (parent of .devspace). Record that root so verbs can set DEVSPACE_BINARY_DIR
    // the way the wrapper does. Single-config repos run from `path` and need none.
    const root =
      basename(dirname(repoPath)) === '.devspace' ? dirname(dirname(repoPath)) : undefined

    const id = basename(repoPath)
    const cfg = parseDevspaceConfig(safeRead(configPath))
    repos.push({
      id,
      name: cfg.name ?? id,
      path: repoPath,
      codeArea: codeAreaOf(repoPath),
      root,
      configPath,
      namespace: cfg.namespace,
      workload: cfg.workload,
      ports: cfg.ports,
      varDefaults: Object.keys(cfg.varDefaults).length ? cfg.varDefaults : undefined,
      workloads: cfg.workloads,
      defaultWorkload: cfg.defaultWorkload,
      workloadType: cfg.workloadType,
      session: sessionName(id),
    })
  }
  const grouped = groupByRoot(repos)
  const identities = new Map<string, string>()
  for (const repo of grouped) {
    const existing = identities.get(repo.id)
    if (existing && existing !== repo.path) {
      throw new Error(`duplicate repo id "${repo.id}": ${existing} and ${repo.path}`)
    }
    identities.set(repo.id, repo.path)
  }
  return grouped.sort((a, b) => a.id.localeCompare(b.id))
}

/** Repos whose workloads live in separate `.devspace/<name>-<type>/` configs
 *  share a wrapper `root`. Fold each such group (2+ configs) into one base repo
 *  whose `members` are those configs — so the repo is one row with a workload
 *  selector, like the `WORKLOAD_TYPE`-question-var repos. Lone configs and
 *  ordinary repos pass through unchanged. */
function groupByRoot(repos: Repo[]): Repo[] {
  const groups = new Map<string, Repo[]>()
  const out: Repo[] = []
  for (const r of repos) {
    if (!r.root) {
      out.push(r)
      continue
    }
    const g = groups.get(r.root)
    if (g) g.push(r)
    else groups.set(r.root, [r])
  }
  for (const [root, members] of groups) {
    if (members.length < 2) {
      out.push(members[0] as Repo)
      continue
    }
    out.push(baseRepo(root, members))
  }
  return out
}

/** Build the one-row base for a multi-config repo from its per-workload members. */
function baseRepo(root: string, members: Repo[]): Repo {
  const id = basename(root)
  const tagged = members
    .map((m) => ({ ...m, workloadType: workloadTypeOf(id, m) }))
    .sort(
      (a, b) =>
        apiFirst(a.workloadType) - apiFirst(b.workloadType) ||
        a.workloadType.localeCompare(b.workloadType),
    )
  const types = tagged.map((m) => m.workloadType)
  const first = tagged[0] as Repo
  return {
    id,
    name: id,
    path: root,
    codeArea: codeAreaOf(root),
    root,
    configPath: first.configPath,
    namespace: first.namespace,
    workload: first.workload,
    ports: [...new Set(tagged.flatMap((m) => m.ports))].sort((a, b) => a - b),
    workloads: types,
    defaultWorkload: types.includes('api') ? 'api' : types[0],
    members: tagged,
    session: sessionName(id),
  }
}

/** A member's workload type: its scalar `WORKLOAD_TYPE`, else the suffix of its
 *  config name after the repo id (`career-service-agents-worker` → `worker`). */
function workloadTypeOf(id: string, m: Repo): string {
  if (m.workloadType) return m.workloadType
  const src = m.name || m.id
  return src.startsWith(`${id}-`) ? src.slice(id.length + 1) : src
}

function apiFirst(type: string): number {
  return type === 'api' ? 0 : 1
}

function codeAreaOf(path: string): Repo['codeArea'] | undefined {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] !== 'Code') continue
    const area = parts[i + 1]
    if (area === 'backend' || area === 'frontend') return area
  }
  // Keep tests and unusual roots platform-tolerant when the path starts at Code.
  if (parts[0] === 'Code') {
    const area = parts[1]
    if (area === 'backend' || area === 'frontend') return area
  }
  return undefined
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
