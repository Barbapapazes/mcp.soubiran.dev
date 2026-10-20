import { createRemoteJWKSet, jwtVerify } from 'jose'

export const CONTENT_SCOPE = 'mcp:content:read'
export const INFRA_SCOPE = 'mcp:infra:read'
export function getAuthConfig(env: Env) {
  return {
    contentResource: new URL('/mcp', env.MCP_PUBLIC_ORIGIN).href,
    infraResource: new URL('/infra/mcp', env.MCP_PUBLIC_ORIGIN).href,
    passportIssuer: env.PASSPORT_ISSUER,
  }
}

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

function trustedKeys(env: Env) {
  const url = new URL(env.PASSPORT_JWKS_URL)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash)
    throw new Error('Invalid JWKS URL')
  let keys = keySets.get(url.href)
  if (!keys) {
    keys = createRemoteJWKSet(url, { cacheMaxAge: 300_000, cooldownDuration: 30_000, timeoutDuration: 5000 })
    keySets.set(url.href, keys)
  }
  return keys
}

export async function validatePassportToken(token: string, resource: string, env: Env) {
  const { contentResource, infraResource, passportIssuer } = getAuthConfig(env)
  if (resource !== contentResource && resource !== infraResource)
    return null
  try {
    // Interactive tokens require Passport's MCP resource-token extension.
    // Stock Passport's client-id audience is deliberately NOT accepted here.
    const { payload } = await jwtVerify(token, trustedKeys(env), {
      algorithms: ['RS256'],
      issuer: passportIssuer,
      audience: resource,
      requiredClaims: ['iss', 'aud', 'sub', 'iat', 'nbf', 'exp', 'jti', 'scopes'],
      maxTokenAge: '5m',
      clockTolerance: 0,
    })
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    const allowed = resource === infraResource ? INFRA_SCOPE : CONTENT_SCOPE
    if (audiences.length !== 1 || audiences[0] !== resource
      || typeof payload.sub !== 'string' || !payload.sub
      || typeof payload.iat !== 'number' || typeof payload.exp !== 'number'
      || payload.exp - payload.iat > 300
      || !Array.isArray(payload.scopes) || payload.scopes.some(scope => scope !== allowed)) {
      return null
    }
    return {
      audience: resource,
      expiresAt: payload.exp,
      scope: payload.scopes as string[],
      props: { kind: 'interactive', scopes: payload.scopes as string[], expiresAt: payload.exp } satisfies Principal,
      userId: payload.sub,
    }
  }
  catch {
    return null
  }
}
