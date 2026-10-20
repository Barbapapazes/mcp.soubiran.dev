import type { Principal } from './auth'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as Sentry from '@sentry/cloudflare'
import { createMcpHandler } from 'agents/mcp'
import { createWorkersLogger } from 'evlog/workers'
import { CONTENT_SCOPE, getAuthConfig } from './auth'
import { shapeError } from './error-context'
import { protectedResource } from './resource-server'
import { registerContentTools } from './tools/content'
import { registerTopologyTools } from './tools/topology'
import { SITE_URL } from './utils'

function createServer(env: Env, topology: boolean, principal: Principal) {
  const server = new McpServer({
    name: topology ? 'Estéban\'s Infrastructure Topology MCP' : 'Estéban\'s MCP Server for soubiran.dev',
    version: '1.0.0',
  })

  if (topology)
    registerTopologyTools(server, env, principal)
  else
    registerContentTools(server, env, principal)

  return server
}

const serveMcp = async (request: Request, env: Env, ctx: ExecutionContext, principal: Principal) => {
  const path = new URL(request.url).pathname
  if (path !== '/mcp' && path !== '/infra/mcp' && path !== '/internal/mcp')
    return new Response('Not found', { status: 404 })
  return createMcpHandler(createServer(env, path === '/infra/mcp', principal), {
    corsOptions: { origin: env.CORS_ALLOWED_ORIGIN },
    route: path,
  })(request, env, ctx)
}

export default Sentry.withSentry(
  env => ({
    dsn: env.SENTRY_DSN,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeBreadcrumb: () => null,
    beforeSend(event) {
      delete event.request
      delete event.breadcrumbs
      return event
    },
    dataCollection: {
      userInfo: false,
      httpBodies: [],
    },
  }),
  {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
      const url = new URL(request.url)
      const resources = getAuthConfig(env)
      const contentResource = protectedResource(resources.contentResource, serveMcp)
      const infraResource = protectedResource(resources.infraResource, serveMcp)
      const startedAt = performance.now()
      const log = createWorkersLogger(new Request(`${url.origin}${url.pathname}`, { method: request.method }), { executionCtx: ctx })

      let response: Response
      let outcome: 'success' | 'http_error' | 'internal_error'

      try {
        if (url.pathname === '/.well-known/openai-apps-challenge') {
          response = new Response('TDwUyOcyufhOWyEr7ZNrPlWMP07hOvF5528GqXCk6Mk', {
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          })
        }
        else if (url.pathname === '/internal/mcp') {
          response = await serveMcp(request, env, ctx, { kind: 'service', scopes: [CONTENT_SCOPE] })
        }
        else if (url.pathname.startsWith('/internal/')) {
          response = new Response('Not found', { status: 404 })
        }
        else if (url.pathname === '/mcp' || url.pathname === '/infra/mcp') {
          response = await (url.pathname === '/infra/mcp' ? infraResource : contentResource).fetch(request, env, ctx)
        }
        else if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
          response = await contentResource.fetch(request, env, ctx)
        }
        else if (url.pathname === '/.well-known/oauth-protected-resource/infra/mcp') {
          response = await infraResource.fetch(request, env, ctx)
        }
        else if (url.pathname === '/authorize' || url.pathname.startsWith('/oauth/') || url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
          response = new Response('Not found', { status: 404 })
        }
        else {
          response = Response.redirect(SITE_URL, 302)
        }
        outcome = response.ok ? 'success' : 'http_error'
      }
      catch (error) {
        Sentry.captureException(error)
        log.setLevel('error')
        log.set({ mcp: { errorCode: 'MCP_HANDLER_FAILED', error: shapeError(error) } })
        outcome = 'internal_error'
        response = new Response('Internal Server Error', { status: 500 })
      }

      log.set({
        request: { durationMs: Math.round(performance.now() - startedAt) },
        mcp: { route: url.pathname === '/mcp' || url.pathname === '/infra/mcp' || url.pathname === '/internal/mcp', outcome },
      })
      log.emit()
      return response
    },
  } satisfies ExportedHandler<Env>,
)
