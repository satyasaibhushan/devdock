// replicas — pure helpers for ephemeral branch-pinned parallel deployments.
// A replica is a git worktree of the parent repo with generated devspace
// configs (renamed workloads, own URL path, pinned image tag) so it deploys
// beside the parent in the same namespace without touching tracked files.
import { dirname, join } from 'node:path'
import { isMap, isScalar, parseDocument } from 'yaml'

/** Keep replica worktrees beside the parent checkout, not inside it. A nested
 * worktree falls under the parent's DevSpace sync root and recursively syncs
 * its own `.agents/replicas` directory. The hidden sibling preserves relative
 * paths to neighboring repositories such as `../ui-support`. */
export function replicaCheckoutPath(parentPath: string, replicaId: string): string {
  return join(dirname(parentPath), `.devdock-${replicaId}`)
}

/** Smallest free `<parentId>-rN`. `isTaken` must answer for every claimant —
 *  registered repos, stored records, and leftover worktree dirs on disk — so
 *  an orphan from a crashed create can never be re-allocated. */
export function nextReplicaId(parentId: string, isTaken: (id: string) => boolean): string {
  for (let n = 1; ; n++) {
    const id = `${parentId}-r${n}`
    if (!isTaken(id)) return id
  }
}

/** A replica's copy of one parent config: same document (comments and anchors
 *  preserved) with the project renamed — `<replicaId>-<type>` for a member
 *  config, plain `<replicaId>` for a single root config (the deployment/
 *  service/helm names and the `svc:` label all flow from `name:`) — and its
 *  own URL path. When `imageTag` is given it is pinned so the replica shares
 *  an existing image (the dev pipeline never builds; an unpinned tag would
 *  ImagePullBackOff); when it references the parent's tag the replica reuses
 *  the parent's image with branch code synced in, and an own-image replica
 *  pins a tag derived from its own name and builds it via deploy first. */
export function generateReplicaConfig(
  parentYaml: string,
  opts: { replicaId: string; workloadType?: string; imageTag?: string },
): string {
  const doc = parseDocument(parentYaml)
  const parentName = doc.get('name')
  const replicaName = opts.workloadType ? `${opts.replicaId}-${opts.workloadType}` : opts.replicaId
  doc.setIn(['name'], replicaName)
  doc.setIn(['vars', 'INGRESS_PATH'], opts.replicaId)
  if (opts.imageTag !== undefined) doc.setIn(['vars', 'IMAGE_TAG'], opts.imageTag)

  // Some repositories interpolate WORKLOAD_NAME in their dev selector, while
  // older UI configs hardcode the project name. Retarget exact hardcoded
  // references so the replica cannot attach to and sync over the primary pod.
  const dev = doc.get('dev', true)
  if (typeof parentName === 'string' && isMap(dev)) {
    for (const targetPair of dev.items) {
      const target = targetPair.value
      if (!isMap(target)) continue
      if (target.get('container') === parentName) target.set('container', replicaName)
      const selector = target.get('labelSelector', true)
      if (!isMap(selector)) continue
      for (const labelPair of selector.items) {
        if (isScalar(labelPair.value) && labelPair.value.value === parentName) {
          labelPair.value.value = replicaName
        }
      }
    }
  }
  return doc.toString()
}

/** The URL path segment a config's chart-created ingress serves it under:
 *  `vars.INGRESS_PATH` (plain or `{ default: … }` form), else the project
 *  name. */
export function ingressPathOf(configYaml: string): string {
  let js: { name?: unknown; vars?: Record<string, unknown> } | undefined
  try {
    js = parseDocument(configYaml).toJS() as typeof js
  } catch {
    return ''
  }
  const raw = js?.vars?.INGRESS_PATH
  const path = typeof raw === 'string' ? raw : (raw as { default?: unknown } | undefined)?.default
  // A value with unresolved interpolation (e.g. `${DEVSPACE_NAME}`) can't be
  // used verbatim; fall back to the project name it resolves to in practice.
  if (typeof path === 'string' && path.trim() && !path.includes('${')) return path.trim()
  return typeof js?.name === 'string' ? js.name : ''
}

/** Alias Ingress giving a replica its own URL path on the shared hostname.
 *  The app's routes carry the parent's hardcoded path prefix regardless of the
 *  rename, so nginx rewrites `/<id>/…` to `/<parent path>/…` before proxying
 *  to the replica's service (validated live). */
export function aliasIngressManifest(opts: {
  replicaId: string
  namespace: string
  host: string
  parentIngressPath: string
  serviceName: string
}): string {
  return `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${opts.replicaId}-alias
  namespace: ${opts.namespace}
  annotations:
    nginx.ingress.kubernetes.io/use-regex: "true"
    nginx.ingress.kubernetes.io/rewrite-target: /${opts.parentIngressPath}/$2
spec:
  ingressClassName: nginx
  rules:
    - host: ${opts.host}
      http:
        paths:
          - path: /${opts.replicaId}(/|$)(.*)
            pathType: ImplementationSpecific
            backend:
              service:
                name: ${opts.serviceName}
                port:
                  number: 80
`
}
