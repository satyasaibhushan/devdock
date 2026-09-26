// oidc — the token-endpoint calls shared by the Kubernetes (AuthManager) and
// AWS (AwsCreds) credential owners. Both refresh silently with a refresh_token
// grant and must tell a dead grant (sign in again) apart from transport
// trouble (retry later, keep the refresh token).

/** Every non-interactive HTTP hop (metadata, token grant). */
export const HTTP_TIMEOUT_MS = 30_000

export interface OidcEndpoints {
  authorize: string
  token: string
}

export interface TokenResponse {
  id_token?: string
  refresh_token?: string
}

/** An OAuth error response from the token endpoint (bad/expired grant) — as
 *  opposed to transport trouble, which must NOT burn the refresh token. */
export class TokenEndpointError extends Error {
  constructor(
    message: string,
    readonly invalidGrant: boolean,
  ) {
    super(message)
  }
}

/** authorize/token endpoints from a provider's metadata document. */
export async function discoverEndpoints(
  fetchFn: typeof fetch,
  metadataUrl: string,
): Promise<OidcEndpoints> {
  const res = await fetchFn(metadataUrl, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`OIDC metadata fetch failed (${res.status})`)
  const meta = (await res.json()) as {
    authorization_endpoint?: unknown
    token_endpoint?: unknown
  }
  if (typeof meta.authorization_endpoint !== 'string' || typeof meta.token_endpoint !== 'string') {
    throw new Error('OIDC metadata is missing its endpoints')
  }
  return { authorize: meta.authorization_endpoint, token: meta.token_endpoint }
}

export async function tokenGrant(
  fetchFn: typeof fetch,
  tokenUrl: string,
  form: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetchFn(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  const body = (await res.json().catch(() => ({}))) as TokenResponse & {
    error?: string
    error_description?: string
  }
  if (!res.ok) {
    throw new TokenEndpointError(
      `OIDC token grant failed: HTTP ${res.status}`,
      res.status === 400 && body.error === 'invalid_grant',
    )
  }
  return body
}
