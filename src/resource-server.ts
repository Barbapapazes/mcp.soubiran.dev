import type { Principal } from './auth'
import { AuthorizationError, CimdFetchError, OAuthAuthorizationServer, OAuthResourceServer, authorizationErrorRedirect, insufficientScope } from '@cloudflare/workers-oauth-provider'
import { CONTENT_RESOURCE, CONTENT_SCOPE, INFRA_RESOURCE, INFRA_SCOPE, ISSUER, validateServiceToken } from './auth'

const UPSTREAM = 'https://api.soubiran.dev'
const CALLBACK = `${ISSUER}/oauth/callback`

export const authorizationServer = new OAuthAuthorizationServer<Env>({
  issuer: ISSUER,
  resources: [CONTENT_RESOURCE, INFRA_RESOURCE],
  defaultResource: CONTENT_RESOURCE,
  clientRegistrationEndpoint: '/oauth/register',
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: [CONTENT_SCOPE, INFRA_SCOPE],
  accessTokenTTL: 300,
  refreshTokenTTL: 0,
})

const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)

export async function interactive(request: Request, env: Env): Promise<Response> {
  const oauth = authorizationServer.getOAuthApi(env)
  const url = new URL(request.url)
  try {
    if (url.pathname === '/authorize' && request.method === 'GET') {
      const auth = await oauth.parseAuthRequest(request)
      // Require PKCE even for confidential MCP clients.
      if (!auth.codeChallenge || auth.codeChallengeMethod !== 'S256')
        return new Response('S256 PKCE is required', { status: 400 })
      const allowed = auth.resource === INFRA_RESOURCE ? INFRA_SCOPE : CONTENT_SCOPE
      if (auth.scope.some(scope => scope !== allowed))
        return new Response('Invalid scope for this resource', { status: 400 })
      auth.scope = auth.scope.length ? auth.scope : [allowed]
      const details = await oauth.describeConsent(auth)
      const consent = await oauth.beginConsent(auth)
      consent.headers.set('Content-Type', 'text/html; charset=utf-8')
      consent.headers.set('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
      return new Response(`<!doctype html><meta charset="utf-8"><title>MCP consent</title>
<h1>Autoriser ${escape(details.clientName)} ?</h1>
<p>${details.clientDomain ? `Domaine : ${escape(details.clientDomain)}` : 'Nom du client auto-déclaré, non vérifié.'}</p>
<p>Destination : ${escape(details.redirectHost)}</p>
${details.redirectIsLoopback ? '<p>Cette autorisation sera transmise à une application sur votre ordinateur.</p>' : ''}
<p>Permissions : ${details.scope.map(escape).join(', ')}</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(consent.handle)}">
<button name="decision" value="approve">Autoriser</button><button name="decision" value="deny">Refuser</button></form>`, { headers: consent.headers })
    }
    if (url.pathname === '/authorize' && request.method === 'POST') {
      const form = await request.formData()
      const handle = String(form.get('handle') ?? '')
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle)
        return new Response(null, { status: 302, headers: denied.headers })
      }
      const approved = await oauth.approveConsent(request, handle)
      const verifier = crypto.randomUUID() + crypto.randomUUID()
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
      const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      const upstream = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers })
      const destination = new URL(`${UPSTREAM}/oauth/authorize`)
      destination.search = new URLSearchParams({
        client_id: env.PASSPORT_INTERACTIVE_CLIENT_ID,
        redirect_uri: CALLBACK,
        response_type: 'code',
        scope: 'mcp:identity',
        state: upstream.state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString()
      upstream.headers.set('Location', destination.href)
      return new Response(null, { status: 302, headers: upstream.headers })
    }
    if (url.pathname === '/oauth/callback' && request.method === 'GET') {
      const resumed = await oauth.finishUpstream<{ verifier: string }>(request)
      const code = url.searchParams.get('code')
      if (!code || url.searchParams.has('error')) {
        resumed.headers.set('Location', authorizationErrorRedirect(resumed.request, 'access_denied'))
        return new Response(null, { status: 302, headers: resumed.headers })
      }
      const response = await fetch(`${UPSTREAM}/oauth/token`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', client_id: env.PASSPORT_INTERACTIVE_CLIENT_ID,
          client_secret: env.PASSPORT_INTERACTIVE_CLIENT_SECRET, redirect_uri: CALLBACK,
          code, code_verifier: resumed.data.verifier,
        }),
      })
      if (!response.ok)
        return new Response('Upstream authentication failed', { status: 401, headers: resumed.headers })
      const tokens = await response.json() as { access_token?: string }
      if (!tokens.access_token)
        return new Response('Upstream authentication failed', { status: 401, headers: resumed.headers })
      const identityResponse = await fetch(`${UPSTREAM}/api/mcp/identity`, {
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
      })
      if (!identityResponse.ok)
        return new Response('Upstream identity failed', { status: 401, headers: resumed.headers })
      const identity = await identityResponse.json() as { id?: string | number }
      if (!identity.id)
        return new Response('Upstream identity failed', { status: 401, headers: resumed.headers })
      const { redirectTo } = await oauth.completeAuthorization({
        request: resumed.request, userId: String(identity.id), metadata: {},
        scope: resumed.request.scope,
        props: { kind: 'interactive', scopes: resumed.request.scope } satisfies Principal,
      })
      // Passport credentials are discarded, never returned to MCP clients or stored in props.
      resumed.headers.set('Location', redirectTo)
      return new Response(null, { status: 302, headers: resumed.headers })
    }
    return new Response('Not found', { status: 404 })
  }
  catch (error) {
    if (error instanceof AuthorizationError || error instanceof CimdFetchError)
      return new Response('Invalid or expired authorization request', { status: 400 })
    // Never attach upstream responses or credentials to telemetry.
    return new Response('Authorization unavailable', { status: 503 })
  }
}

export function protectedResource(resource: string, handler: (request: Request, env: Env, ctx: ExecutionContext, principal: Principal) => Promise<Response>) {
  const required = resource === INFRA_RESOURCE ? INFRA_SCOPE : CONTENT_SCOPE
  return new OAuthResourceServer<Env, Principal>({
    resourceMetadata: { resource, authorization_servers: [ISSUER] },
    requiredScopes: [required],
    validateToken: env => async (audience, token) => {
      if (token.split('.').length === 3)
        return validateServiceToken(token, audience, env)
      return authorizationServer.validateToken<Principal>(audience, token, env)
    },
    handler: {
      async fetch(request, env, ctx) {
        const principal = { ...ctx.props, scopes: ctx.auth.scope, expiresAt: ctx.auth.expiresAt }
        if (!principal.scopes.includes(required) || (resource === INFRA_RESOURCE && principal.kind !== 'interactive'))
          return insufficientScope(ctx.auth, [required])
        return handler(request, env, ctx, principal)
      },
    },
  })
}
