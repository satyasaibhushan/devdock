import { parse } from 'yaml'

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
