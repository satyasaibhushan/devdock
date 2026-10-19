import type { Repo } from './types.js'

export const sandboxSlot = (slot: string): boolean => /^sb[1-9]\d*$/.test(slot)

export function guardSandboxName(name: string, slot: string): string {
  if (!sandboxSlot(slot) || !name.split('-').includes(slot) || !/^[a-z0-9][a-z0-9-]*$/.test(name))
    throw new Error(`Unsafe sandbox resource name: ${name}`)
  return name
}

export function sandboxWorkloadName(repo: Repo, workload: string, slot: string): string {
  return guardSandboxName(`${repo.devspaceTemplateName ?? repo.name}-${slot}-${workload}`, slot)
}

export function sandboxHost(host: string, namespace: string, slot: string): string {
  if (!sandboxSlot(slot)) throw new Error('Invalid sandbox slot')
  const index = host.indexOf(`-${namespace}`)
  const end = index + namespace.length + 1
  if (index < 0 || !['-', '.'].includes(host[end] ?? ''))
    throw new Error(`Host ${host} does not contain personal namespace ${namespace}`)
  return `${host.slice(0, end)}-${slot}${host.slice(end)}`
}

/** Replace exact URL authorities, including short and namespace-qualified service DNS. */
export function rewriteSandboxEnv(
  text: string,
  namespace: string,
  services: ReadonlyMap<string, string>,
  hosts: ReadonlyMap<string, string>,
): string {
  return text.replace(
    /(https?:\/\/)([a-zA-Z0-9.-]+)(?=[:/\s"'#?]|$)/g,
    (url, scheme: string, host: string) => {
      const external = hosts.get(host)
      if (external) return `${scheme}${external}`
      for (const [name, replacement] of services)
        for (const suffix of [
          '',
          `.${namespace}`,
          `.${namespace}.svc`,
          `.${namespace}.svc.cluster.local`,
        ])
          if (host === `${name}${suffix}`) return `${scheme}${replacement}${suffix}`
      return url
    },
  )
}

export interface SandboxIngress {
  metadata?: { name?: string; annotations?: Record<string, string> }
  spec?: {
    ingressClassName?: string
    rules?: { host?: string; http?: { paths: IngressPath[] } }[]
  }
}
interface IngressPath {
  path?: string
  pathType?: string
  backend: { service?: { name: string; port?: { number?: number; name?: string } } }
}

export function sandboxRouting(
  ingresses: SandboxIngress[],
  namespace: string,
  slot: string,
  services: ReadonlyMap<string, string>,
) {
  const hosts = new Map<string, string>()
  const memberPaths = new Map<string, Set<string>>()
  for (const ingress of ingresses)
    for (const rule of ingress.spec?.rules ?? []) {
      if (!rule.host) continue
      for (const path of rule.http?.paths ?? [])
        if (services.has(path.backend.service?.name ?? '')) {
          hosts.set(rule.host, sandboxHost(rule.host, namespace, slot))
          const paths = memberPaths.get(rule.host) ?? new Set<string>()
          paths.add(path.path ?? '/')
          memberPaths.set(rule.host, paths)
        }
    }
  const tls = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: guardSandboxName(`devdock-${slot}-tls`, slot),
      namespace,
      annotations: {
        'cert-manager.io/cluster-issuer': 'lets-encrypt-issuer',
        'nginx.org/mergeable-ingress-type': 'master',
      },
    },
    spec: {
      ingressClassName: 'nginx',
      tls: [{ hosts: [...hosts.values()], secretName: `devdock-${slot}-tls` }],
      rules: [...hosts.values()].map((host) => ({ host })),
    },
  }
  const fallback = ingresses.flatMap((ingress, index) => {
    const rules = (ingress.spec?.rules ?? []).flatMap((rule) => {
      if (!rule.host?.startsWith('api-') || !hosts.has(rule.host)) return []
      const paths = (rule.http?.paths ?? []).filter(
        (path) =>
          !services.has(path.backend.service?.name ?? '') &&
          !memberPaths.get(rule.host as string)?.has(path.path ?? '/'),
      )
      return paths.length ? [{ host: hosts.get(rule.host), http: { paths } }] : []
    })
    if (!rules.length) return []
    const annotations = Object.fromEntries(
      Object.entries(ingress.metadata?.annotations ?? {}).filter(
        ([key]) => key.startsWith('nginx.org/') || key.startsWith('nginx.ingress.kubernetes.io/'),
      ),
    )
    return [
      {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'Ingress',
        metadata: {
          name: guardSandboxName(`devdock-${slot}-route-${index}`, slot),
          namespace,
          labels: { 'devdock-sandbox-slot': slot, 'devdock-sandbox-routing': 'true' },
          annotations: { ...annotations, 'nginx.org/mergeable-ingress-type': 'minion' },
        },
        spec: { ingressClassName: ingress.spec?.ingressClassName ?? 'nginx', rules },
      },
    ]
  })
  return { hosts, tls, fallback }
}
