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

/** Parse the relevant fields out of a devspace.yaml string. Pure + testable. */
export function parseDevspaceConfig(yamlText: string): {
  name?: string
  namespace?: string
  workload?: string
  ports: number[]
  varDefaults: Record<string, string>
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
  for (const [key, value] of Object.entries(asRecord(d.vars) ?? {})) {
    const entry = asRecord(value)
    if (!entry || !('question' in entry)) continue
    const options = Array.isArray(entry.options) ? entry.options : []
    const answer = entry.default ?? options[0]
    if (typeof answer === 'string' || typeof answer === 'number' || typeof answer === 'boolean') {
      varDefaults[key] = String(answer)
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

  return { name, namespace, workload, ports: [...ports].sort((a, b) => a - b), varDefaults }
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

    const id = basename(repoPath)
    const cfg = parseDevspaceConfig(safeRead(configPath))
    repos.push({
      id,
      name: cfg.name ?? id,
      path: repoPath,
      configPath,
      namespace: cfg.namespace,
      workload: cfg.workload,
      ports: cfg.ports,
      varDefaults: Object.keys(cfg.varDefaults).length ? cfg.varDefaults : undefined,
      session: sessionName(id),
    })
  }
  return repos.sort((a, b) => a.id.localeCompare(b.id))
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
