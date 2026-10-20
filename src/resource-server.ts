import type { Principal } from './auth'
import { CONTENT_SCOPE, getAuthConfig, INFRA_SCOPE, validatePassportToken } from './auth'

// This Worker is only a resource server. Passport owns authorization and tokens.
export function protectedResource(resource: string, handler: (request: Request, env: Env, ctx: ExecutionContext, principal: Principal) => Promise<Response>) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const { infraResource, passportIssuer } = getAuthConfig(env)
      const required = resource === infraResource ? INFRA_SCOPE : CONTENT_SCOPE
      const metadataUrl = new URL(`/.well-known/oauth-protected-resource${new URL(resource).pathname}`, env.MCP_PUBLIC_ORIGIN).href
      const headers = new Headers({
        'Access-Control-Allow-Origin': env.CORS_ALLOWED_ORIGIN,
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID',
        'Access-Control-Expose-Headers': 'WWW-Authenticate, MCP-Session-Id, MCP-Protocol-Version',
        'Cache-Control': 'no-store',
        'Vary': 'Origin',
      })
      if (request.method === 'OPTIONS')
        return new Response(null, { status: 204, headers })
      if (new URL(request.url).pathname === new URL(metadataUrl).pathname) {
        if (request.method !== 'GET') {
          headers.set('Allow', 'GET, OPTIONS')
          return new Response('Method not allowed', { status: 405, headers })
        }
        headers.set('Content-Type', 'application/json')
        return new Response(JSON.stringify({
          resource,
          authorization_servers: [passportIssuer],
          scopes_supported: [required],
          bearer_methods_supported: ['header'],
        }), { headers })
      }
      const authorization = request.headers.get('Authorization')
      const token = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1]
      const authenticated = token ? await validatePassportToken(token, resource, env) : null
      if (!authenticated) {
        headers.set('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}"${authorization ? ', error="invalid_token"' : ''}`)
        return new Response('Unauthorized', { status: 401, headers })
      }
      if (!authenticated.props.scopes.includes(required)
        || (resource === infraResource && authenticated.props.kind !== 'interactive')) {
        headers.set('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${required}", resource_metadata="${metadataUrl}"`)
        return new Response('Forbidden', { status: 403, headers })
      }
      return handler(request, env, ctx, authenticated.props)
    },
  }
}
