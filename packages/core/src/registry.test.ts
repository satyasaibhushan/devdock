import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseDevspaceConfig, scanRepos, sessionName } from './registry.js'

describe('parseDevspaceConfig', () => {
  it('extracts name, namespace, workload, and ports', () => {
    const cfg = parseDevspaceConfig(`
name: career-service
deployments:
  app:
    helm: {}
dev:
  app:
    namespace: career
    ports:
      - port: "8080:80"
      - port: 5005
`)
    expect(cfg.name).toBe('career-service')
    expect(cfg.workload).toBe('app')
    expect(cfg.namespace).toBe('career')
    expect(cfg.ports).toEqual([5005, 8080])
  })

  it('is defensive against junk', () => {
    expect(parseDevspaceConfig(': not : valid :')).toEqual({ ports: [], varDefaults: {} })
    expect(parseDevspaceConfig('')).toEqual({ ports: [], varDefaults: {} })
  })

  it('captures defaults of question vars (the ones that prompt), skipping the rest', () => {
    const cfg = parseDevspaceConfig(`
name: svc
vars:
  WORKLOAD_TYPE:
    question: Which workload type do you want to work on?
    default: "api"
    options: ["api", "cron", "worker"]
  TARGET_REGION:
    question: Which region?
    default: "us"
  OPTIONS_ONLY:
    question: Which workload type do you want to work on?
    options: ["worker", "cron"]
  NO_DEFAULT:
    question: Pick something?
  PLAIN_VALUE: api
  COMPUTED: \${DEVSPACE_NAME}
`)
    expect(cfg.varDefaults).toEqual({
      WORKLOAD_TYPE: 'api',
      TARGET_REGION: 'us',
      OPTIONS_ONLY: 'worker',
    })
  })

  it('captures WORKLOAD_TYPE options as the repo’s deployable workloads', () => {
    const cfg = parseDevspaceConfig(`
name: acs-org-management
vars:
  WORKLOAD_TYPE:
    question: Which workload type?
    default: "api"
    options: ["api", "cron", "worker"]
`)
    expect(cfg.workloads).toEqual(['api', 'cron', 'worker'])
    expect(cfg.defaultWorkload).toBe('api')
  })

  it('uses the first option as the default workload when none is declared', () => {
    const cfg = parseDevspaceConfig(`
name: cmc-webhook-server
vars:
  WORKLOAD_TYPE:
    question: Which workload type?
    options: ["worker"]
`)
    expect(cfg.workloads).toEqual(['worker'])
    expect(cfg.defaultWorkload).toBe('worker')
  })

  it('leaves workloads unset when WORKLOAD_TYPE is not a question var with options', () => {
    const cfg = parseDevspaceConfig('name: svc\nvars:\n  WORKLOAD_TYPE: api\n')
    expect(cfg.workloads).toBeUndefined()
    expect(cfg.defaultWorkload).toBeUndefined()
  })
})

describe('sessionName', () => {
  it('prefixes with devdock-', () => {
    expect(sessionName('career-service')).toBe('devdock-career-service')
  })
})

describe('scanRepos', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'devdock-scan-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('discovers repos and skips ignored dirs', () => {
    mkdirSync(join(root, 'svc-a'), { recursive: true })
    writeFileSync(join(root, 'svc-a', 'devspace.yaml'), 'name: svc-a\n')
    mkdirSync(join(root, 'svc-a', 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'svc-a', 'node_modules', 'pkg', 'devspace.yaml'), 'name: nope\n')

    const repos = scanRepos({ roots: [root] })
    expect(repos).toHaveLength(1)
    expect(repos[0]?.id).toBe('svc-a')
    expect(repos[0]?.session).toBe('devdock-svc-a')
  })

  it('groups per-service configs in multi-service repos into one row (.devspace/<service>/)', () => {
    // the ./devspace wrapper pattern: no root devspace.yaml, one per workload.
    // The sibling configs collapse into a single `agents` row with members.
    const repo = join(root, 'agents')
    mkdirSync(join(repo, '.devspace', 'agents-api'), { recursive: true })
    mkdirSync(join(repo, '.devspace', 'agents-worker'), { recursive: true })
    mkdirSync(join(repo, '.devspace', 'logs'), { recursive: true }) // cache dir, no yaml
    writeFileSync(
      join(repo, '.devspace', 'agents-api', 'devspace.yaml'),
      'name: agents-api\nvars:\n  WORKLOAD_TYPE: api\n',
    )
    writeFileSync(
      join(repo, '.devspace', 'agents-worker', 'devspace.yaml'),
      'name: agents-worker\nvars:\n  WORKLOAD_TYPE: worker\n',
    )

    const repos = scanRepos({ roots: [root] })
    expect(repos.map((r) => r.id)).toEqual(['agents'])
    const base = repos[0]
    // one row, named for the repo dir; api sorts first; root is the wrapper dir.
    expect(base?.name).toBe('agents')
    expect(base?.path).toBe(repo)
    expect(base?.root).toBe(repo)
    expect(base?.session).toBe('devdock-agents')
    expect(base?.workloads).toEqual(['api', 'worker'])
    expect(base?.defaultWorkload).toBe('api')
    // members are the per-workload configs, each rooted at its own service dir.
    expect(base?.members?.map((m) => m.workloadType)).toEqual(['api', 'worker'])
    expect(base?.members?.[0]?.path).toBe(join(repo, '.devspace', 'agents-api'))
    expect(base?.members?.[0]?.name).toBe('agents-api')
    expect(base?.members?.[0]?.root).toBe(repo)
  })

  it('derives a member workload type from its name suffix when no scalar var', () => {
    const repo = join(root, 'agents')
    mkdirSync(join(repo, '.devspace', 'agents-api'), { recursive: true })
    mkdirSync(join(repo, '.devspace', 'agents-worker'), { recursive: true })
    writeFileSync(join(repo, '.devspace', 'agents-api', 'devspace.yaml'), 'name: agents-api\n')
    writeFileSync(
      join(repo, '.devspace', 'agents-worker', 'devspace.yaml'),
      'name: agents-worker\n',
    )

    const base = scanRepos({ roots: [root] })[0]
    expect(base?.workloads).toEqual(['api', 'worker'])
  })

  it('leaves a lone .devspace/<service>/ config ungrouped', () => {
    const repo = join(root, 'agents')
    mkdirSync(join(repo, '.devspace', 'agents-api'), { recursive: true })
    writeFileSync(join(repo, '.devspace', 'agents-api', 'devspace.yaml'), 'name: agents-api\n')

    const repos = scanRepos({ roots: [root] })
    expect(repos.map((r) => r.id)).toEqual(['agents-api'])
    expect(repos[0]?.workloads).toBeUndefined()
    expect(repos[0]?.members).toBeUndefined()
  })

  it('leaves root unset for a single-config repo at its own root', () => {
    mkdirSync(join(root, 'svc-a'), { recursive: true })
    writeFileSync(join(root, 'svc-a', 'devspace.yaml'), 'name: svc-a\n')
    const repos = scanRepos({ roots: [root] })
    expect(repos[0]?.root).toBeUndefined()
  })

  it('classifies repos from the local Code frontend/backend buckets', () => {
    const codeRoot = join(root, 'Code')
    mkdirSync(join(codeRoot, 'frontend', 'jobs-ui'), { recursive: true })
    mkdirSync(join(codeRoot, 'backend', 'jobs-api'), { recursive: true })
    writeFileSync(join(codeRoot, 'frontend', 'jobs-ui', 'devspace.yaml'), 'name: jobs-ui\n')
    writeFileSync(join(codeRoot, 'backend', 'jobs-api', 'devspace.yaml'), 'name: jobs-api\n')

    const repos = scanRepos({ roots: [codeRoot] })
    expect(repos.find((r) => r.id === 'jobs-ui')?.codeArea).toBe('frontend')
    expect(repos.find((r) => r.id === 'jobs-api')?.codeArea).toBe('backend')
  })

  it('fails instead of overwriting two repos with the same id', () => {
    for (const area of ['backend', 'frontend']) {
      mkdirSync(join(root, area, 'shared-name'), { recursive: true })
      writeFileSync(join(root, area, 'shared-name', 'devspace.yaml'), 'name: shared-name\n')
    }
    expect(() => scanRepos({ roots: [join(root, 'backend'), join(root, 'frontend')] })).toThrow(
      /duplicate repo id "shared-name"/,
    )
  })
})
