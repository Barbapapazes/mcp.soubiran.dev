import { createRemoteJWKSet, jwtVerify } from 'jose'

export const CONTENT_SCOPE = 'mcp:content:read'
export const INFRA_SCOPE = 'mcp:infra:read'
export const ISSUER = 'https://mcp.soubiran.dev'
export const CONTENT_RESOURCE = `${ISSUER}/mcp`
export const INFRA_RESOURCE = `${ISSUER}/infra/mcp`

export interface Principal {
  kind: 'interactive' | 'service'
  scopes: string[]
  expiresAt?: number
}

const contentTools = new Set(['search_content', 'list_pages', 'get_page'])

export function canUseTool(principal: Principal | undefined, tool: string): boolean {
  if (!principal || (principal.expiresAt !== undefined && principal.expiresAt <= Date.now() / 1000))
    return false
  if (contentTools.has(tool))
    return principal.scopes.includes(CONTENT_SCOPE)
  return tool === 'query_topology' && principal.kind === 'interactive' && principal.scopes.includes(INFRA_SCOPE)
}

export function requireTool(principal: Principal | undefined, tool: string): void {
  if (!canUseTool(principal, tool))
    throw new Error('Tool access denied')
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export async function validateServiceToken(token: string, resource: string, env: Env) {
  // JWT-shaped credentials never fall back to the Worker's opaque-token validator.
  if (resource !== CONTENT_RESOURCE || !env.PASSPORT_SERVICE_CLIENT_ID)
    return null
  try {
    const url = new URL(env.PASSPORT_JWKS_URL)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return null
    let keys = keySets.get(url.href)
    if (!keys) {
      keys = createRemoteJWKSet(url, { cacheMaxAge: 300_000, cooldownDuration: 30_000, timeoutDuration: 5000 })
      keySets.set(url.href, keys)
    }
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'],
      audience: env.PASSPORT_SERVICE_CLIENT_ID,
      requiredClaims: ['aud', 'sub', 'iat', 'nbf', 'exp', 'jti', 'scopes'],
      maxTokenAge: '5m',
      clockTolerance: 0,
    })
    // Passport 13 / League 9.4: aud is the OAuth client, sub is the client for
    // client_credentials, scopes is an array, and iss / kid are not emitted.
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    if (audiences.length !== 1 || audiences[0] !== env.PASSPORT_SERVICE_CLIENT_ID
      || payload.sub !== env.PASSPORT_SERVICE_CLIENT_ID
      || payload.iss !== undefined
      || typeof payload.iat !== 'number' || typeof payload.exp !== 'number'
      || payload.exp - payload.iat > 300
      || !Array.isArray(payload.scopes) || payload.scopes.length !== 1 || payload.scopes[0] !== CONTENT_SCOPE)
      return null
    return {
      audience: CONTENT_RESOURCE,
      expiresAt: payload.exp,
      scope: [CONTENT_SCOPE],
      props: { kind: 'service', scopes: [CONTENT_SCOPE], expiresAt: payload.exp } satisfies Principal,
      clientId: env.PASSPORT_SERVICE_CLIENT_ID,
      userId: payload.sub,
    }
  }
  catch {
    return null
  }
}
