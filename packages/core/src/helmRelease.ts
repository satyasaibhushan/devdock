import { parse, parseAllDocuments } from 'yaml'

/** DevSpace print includes imported deployments and resolves the workload vars. */
export function helmReleaseNames(effectiveYaml: string): string[] {
  const start = effectiveYaml.search(/^version:/m)
  const config = parse(start > 0 ? effectiveYaml.slice(start) : effectiveYaml) as {
    deployments?: Record<string, { helm?: { releaseName?: string } }>
  } | null
  const names = new Set<string>()
  for (const [key, deployment] of Object.entries(config?.deployments ?? {})) {
    if (deployment?.helm) names.add(deployment.helm.releaseName || key)
  }
  return [...names]
}

interface ServicePort {
  name?: string
  port: number
  targetPort?: number | string
  protocol?: string
  appProtocol?: string
}

/** The installed manifest includes the chart's defaults and all values files. */
export function clusterIPService(manifest: string, name: string, namespace: string) {
  for (const document of parseAllDocuments(manifest)) {
    if (document.errors.length) continue
    const resource = document.toJS() as {
      kind?: string
      metadata?: { name?: string; namespace?: string }
      spec?: {
        type?: string
        clusterIP?: string
        selector?: Record<string, string>
        ports?: ServicePort[]
      }
    } | null
    if (
      resource?.kind !== 'Service' ||
      resource.metadata?.name !== name ||
      (resource.metadata.namespace && resource.metadata.namespace !== namespace)
    )
      continue
    const spec = resource.spec
    if (!spec || (spec.type ?? 'ClusterIP') !== 'ClusterIP' || spec.clusterIP === 'None') continue
    return {
      selector: spec.selector ?? { svc: name },
      ports: spec.ports?.length ? spec.ports : [{ port: 80, targetPort: 80 }],
    }
  }
}
