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

  it('discovers per-service configs in multi-service repos (.devspace/<service>/)', () => {
    // the ./devspace wrapper pattern: no root devspace.yaml, one per service.
    const repo = join(root, 'agents')
    mkdirSync(join(repo, '.devspace', 'agents-api'), { recursive: true })
    mkdirSync(join(repo, '.devspace', 'agents-worker'), { recursive: true })
    mkdirSync(join(repo, '.devspace', 'logs'), { recursive: true }) // cache dir, no yaml
    writeFileSync(join(repo, '.devspace', 'agents-api', 'devspace.yaml'), 'name: agents-api\n')
    writeFileSync(
      join(repo, '.devspace', 'agents-worker', 'devspace.yaml'),
      'name: agents-worker\n',
    )

    const repos = scanRepos({ roots: [root] })
    expect(repos.map((r) => r.id)).toEqual(['agents-api', 'agents-worker'])
    // path is the service dir — devspace commands run where the wrapper runs them.
    expect(repos[0]?.path).toBe(join(repo, '.devspace', 'agents-api'))
    expect(repos[0]?.name).toBe('agents-api')
    expect(repos[0]?.session).toBe('devdock-agents-api')
  })
})
