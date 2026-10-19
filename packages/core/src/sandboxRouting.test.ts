import { describe, expect, it } from 'vitest'
import {
  type SandboxIngress,
  guardSandboxName,
  rewriteSandboxEnv,
  sandboxHost,
  sandboxRouting,
} from './sandboxRouting.js'

const services = new Map([['dashboard-api-accounts-api', 'dashboard-api-accounts-sb1-api']])
const hosts = new Map([
  ['api-saibhushan-candidate.vmock.dev', 'api-saibhushan-sb1-candidate.vmock.dev'],
  ['dashboard-saibhushan.vmock.dev', 'dashboard-saibhushan-sb1.vmock.dev'],
])

describe('sandbox names and env', () => {
  it('guards slot boundaries on every resource kind', () => {
    for (const name of [
      'dashboard-api-accounts-api',
      'devdock-sb10-tls',
      'devdock-xsb1-tls',
      'app-sb1/api',
    ])
      expect(() => guardSandboxName(name, 'sb1')).toThrow('Unsafe')
    for (const name of [
      'dashboard-api-accounts-sb1-api',
      'devdock-sandbox-sb1',
      'devdock-sb1-tls',
      'devdock-sb1-route-1',
    ])
      expect(guardSandboxName(name, 'sb1')).toBe(name)
    expect(() => guardSandboxName('app-personal-api', 'personal')).toThrow('Unsafe')
  })
  it('rewrites only exact member URL authorities, with ports, paths and service DNS intact', () => {
    const input = [
      'A=http://dashboard-api-accounts-api/dashboard-api-accounts/v1',
      'B="http://dashboard-api-accounts-api.saibhushan.svc.cluster.local:8080/path?q=1"',
      'C=https://api-saibhushan-candidate.vmock.dev/non-member/path',
      'D=https://dashboard-saibhushan.vmock.dev/',
      'E=http://other-api/path',
      'F=http://dashboard-api-accounts-api.other.svc/path',
      'G=http://dashboard-api-accounts-api-extra/path',
      'H=https://other-saibhushan.vmock.dev/',
    ].join('\n')
    expect(rewriteSandboxEnv(input, 'saibhushan', services, hosts)).toBe(
      input
        .replace('http://dashboard-api-accounts-api/', 'http://dashboard-api-accounts-sb1-api/')
        .replace(
          'http://dashboard-api-accounts-api.saibhushan',
          'http://dashboard-api-accounts-sb1-api.saibhushan',
        )
        .replace('https://api-saibhushan-candidate', 'https://api-saibhushan-sb1-candidate')
        .replace('https://dashboard-saibhushan.', 'https://dashboard-saibhushan-sb1.'),
    )
  })
  it('replaces the namespace part of API and UI hosts only', () => {
    for (const [host, expected] of hosts)
      expect(sandboxHost(host, 'saibhushan', 'sb1')).toBe(expected)
    expect(() => sandboxHost('api-other-candidate.vmock.dev', 'saibhushan', 'sb1')).toThrow()
  })
})

it('builds TLS and preserves non-member path backends and nginx routing settings', () => {
  const path = (route: string, service: string) => ({
    path: route,
    pathType: 'Prefix',
    backend: { service: { name: service, port: { number: 80 } } },
  })
  const ingresses: SandboxIngress[] = [
    {
      metadata: {
        name: 'accounts',
        annotations: {
          'nginx.org/rewrites': 'serviceName=other-api rewrite=/',
          'external-dns.alpha.kubernetes.io/hostname': 'personal-host',
        },
      },
      spec: {
        ingressClassName: 'nginx',
        rules: [
          {
            host: 'api-saibhushan-candidate.vmock.dev',
            http: {
              paths: [path('/accounts', 'dashboard-api-accounts-api'), path('/other', 'other-api')],
            },
          },
        ],
      },
    },
    {
      spec: {
        rules: [
          {
            host: 'api-saibhushan-candidate.vmock.dev',
            http: { paths: [path('/accounts', 'old-proxy')] },
          },
        ],
      },
    },
  ]
  const routing = sandboxRouting(ingresses, 'saibhushan', 'sb1', services)
  expect(routing.tls.spec).toEqual({
    ingressClassName: 'nginx',
    tls: [{ hosts: ['api-saibhushan-sb1-candidate.vmock.dev'], secretName: 'devdock-sb1-tls' }],
    rules: [{ host: 'api-saibhushan-sb1-candidate.vmock.dev' }],
  })
  expect(routing.fallback).toHaveLength(1)
  expect(routing.fallback[0]?.spec.rules[0]?.http.paths).toEqual([path('/other', 'other-api')])
  expect(routing.fallback[0]?.metadata.annotations).toEqual({
    'nginx.org/rewrites': 'serviceName=other-api rewrite=/',
    'nginx.org/mergeable-ingress-type': 'minion',
  })
  expect(ingresses[0]?.spec?.rules?.[0]?.http?.paths).toHaveLength(2)
})
