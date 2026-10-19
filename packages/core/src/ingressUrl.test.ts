import { describe, expect, it } from 'vitest'
import { parseIngressUrls } from './ingressUrl.js'

describe('parseIngressUrls', () => {
  it.each([
    ['dashboard-ui', '/', '/-2'],
    ['dashboard-api-accounts', '/dashboard-api-accounts', '/dashboard-api-accounts-2'],
  ])('uses only the first path for %s', (name, path, duplicate) => {
    const urls = parseIngressUrls(
      JSON.stringify({
        items: [
          {
            metadata: { name },
            spec: {
              rules: [
                { host: 'dashboard.example', http: { paths: [{ path }, { path: duplicate }] } },
              ],
            },
          },
        ],
      }),
    )
    expect([...urls]).toEqual([[name, `https://dashboard.example${path}`]])
  })

  it('skips rules without a host or paths and uses the first routable rule', () => {
    const urls = parseIngressUrls(
      JSON.stringify({
        items: [
          {
            metadata: { name: 'app' },
            spec: {
              rules: [
                { http: { paths: [{ path: '/no-host' }] } },
                { host: 'tls.example' },
                { host: 'empty.example', http: { paths: [] } },
                { host: 'app.example', http: { paths: [{ path: '/app' }] } },
                { host: 'other.example', http: { paths: [{ path: '/other' }] } },
              ],
            },
          },
        ],
      }),
    )
    expect([...urls]).toEqual([['app', 'https://app.example/app']])
  })

  it('omits TLS-only ingresses, including host rules without paths', () => {
    expect(
      parseIngressUrls(
        JSON.stringify({
          items: [
            { metadata: { name: 'devdock-sb1-tls' }, spec: { tls: [{ hosts: ['app.example'] }] } },
            { metadata: { name: 'personal' }, spec: { rules: [{ host: 'app.example' }] } },
          ],
        }),
      ),
    ).toEqual(new Map())
  })

  it.each(['not json', '{}', 'null'])('tolerates an invalid list: %s', (json) => {
    expect(parseIngressUrls(json)).toEqual(new Map())
  })
})
