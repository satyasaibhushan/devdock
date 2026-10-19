interface Ingress {
  metadata?: { name?: string }
  spec?: { rules?: { host?: string; http?: { paths?: { path?: string }[] } }[] }
}

/** One URL per ingress, using the first path of the first routable rule. */
export function parseIngressUrls(json: string): Map<string, string> {
  const urls = new Map<string, string>()
  let doc: { items?: Ingress[] } | null
  try {
    doc = JSON.parse(json)
  } catch {
    return urls
  }
  if (!Array.isArray(doc?.items)) return urls
  for (const ingress of doc.items) {
    const name = ingress?.metadata?.name
    if (!name) continue
    const rule = ingress.spec?.rules?.find((rule) => rule.host && rule.http?.paths?.length)
    if (rule) urls.set(name, `https://${rule.host}${rule.http?.paths?.[0]?.path ?? '/'}`)
  }
  return urls
}
