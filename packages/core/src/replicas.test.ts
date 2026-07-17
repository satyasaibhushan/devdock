import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  aliasIngressManifest,
  generateReplicaConfig,
  ingressPathOf,
  nextReplicaId,
} from './replicas.js'

// Verbatim excerpt of a real member config (career-service-agents-api) — the
// generator must round-trip everything it doesn't touch, comments included.
const MEMBER_CONFIG = `version: v2beta1
name: career-service-agents-api

imports:
  - git: git@github.com:vmockinc/guidelines.git
    branch: master
    subPath: ./devspace/non-ui

vars:
  DEVSPACE_BINARY_DIR:
    source: env
    default: ./../../
  WORKLOAD_TYPE: api
  WORKLOAD_NAME: \${DEVSPACE_NAME}
  TEAM_NAME: cmc
  INGRESS_HOSTNAME: api-\${ENVIRONMENT_NAME}-\${TEAM_NAME}.\${ROOT_DOMAIN}
  INGRESS_PATH: career-service-agents
  WORKING_DIR: /app

# This is a list of dev containers based on the deployment's containers
dev:
  common:
    labelSelector:
      svc: \${WORKLOAD_NAME}
    container: \${WORKLOAD_NAME}
`

describe('nextReplicaId', () => {
  it('allocates the smallest free rN', () => {
    const taken = new Set(['svc-r1', 'svc-r3'])
    expect(nextReplicaId('svc', (id) => taken.has(id))).toBe('svc-r2')
  })
  it('starts at r1 when nothing is taken', () => {
    expect(nextReplicaId('svc', () => false)).toBe('svc-r1')
  })
})

describe('generateReplicaConfig', () => {
  const out = generateReplicaConfig(MEMBER_CONFIG, {
    replicaId: 'career-service-agents-r1',
    workloadType: 'api',
    imageTag: 'saibhushan-career-service-agents-api',
  })
  const js = parseYaml(out)

  it('renames the workload and pins path + image tag', () => {
    expect(js.name).toBe('career-service-agents-r1-api')
    expect(js.vars.INGRESS_PATH).toBe('career-service-agents-r1')
    expect(js.vars.IMAGE_TAG).toBe('saibhushan-career-service-agents-api')
  })

  it('leaves everything else untouched, comments included', () => {
    expect(js.vars.WORKLOAD_TYPE).toBe('api')
    expect(js.vars.DEVSPACE_BINARY_DIR).toEqual({ source: 'env', default: './../../' })
    expect(js.dev.common.labelSelector.svc).toBe('${WORKLOAD_NAME}')
    expect(js.imports).toEqual(parseYaml(MEMBER_CONFIG).imports)
    expect(out).toContain('# This is a list of dev containers')
  })
})

describe('ingressPathOf', () => {
  it('reads vars.INGRESS_PATH', () => {
    expect(ingressPathOf(MEMBER_CONFIG)).toBe('career-service-agents')
  })
  it('reads the { default } var form', () => {
    expect(ingressPathOf('name: x\nvars:\n  INGRESS_PATH:\n    default: y\n')).toBe('y')
  })
  it('falls back to the project name, and to empty on junk', () => {
    expect(ingressPathOf('name: svc\nvars: {}\n')).toBe('svc')
    expect(ingressPathOf(': not yaml :')).toBe('')
  })
})

describe('aliasIngressManifest', () => {
  const manifest = aliasIngressManifest({
    replicaId: 'career-service-agents-r1',
    namespace: 'saibhushan',
    host: 'api-saibhushan-cmc.vmock.dev',
    parentIngressPath: 'career-service-agents',
    serviceName: 'career-service-agents-r1-api',
  })
  const js = parseYaml(manifest)

  it('routes /<id>/ to the replica service, rewriting to the parent path', () => {
    expect(js.metadata.name).toBe('career-service-agents-r1-alias')
    expect(js.metadata.namespace).toBe('saibhushan')
    expect(js.metadata.annotations['nginx.ingress.kubernetes.io/use-regex']).toBe('true')
    expect(js.metadata.annotations['nginx.ingress.kubernetes.io/rewrite-target']).toBe(
      '/career-service-agents/$2',
    )
    const rule = js.spec.rules[0]
    expect(rule.host).toBe('api-saibhushan-cmc.vmock.dev')
    expect(rule.http.paths[0].path).toBe('/career-service-agents-r1(/|$)(.*)')
    expect(rule.http.paths[0].backend.service).toEqual({
      name: 'career-service-agents-r1-api',
      port: { number: 80 },
    })
  })
})
