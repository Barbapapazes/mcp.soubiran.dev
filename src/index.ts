import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as Sentry from '@sentry/cloudflare'
import { createMcpHandler } from 'agents/mcp'
import { createWorkersLogger } from 'evlog/workers'
import { shapeError } from './error-context'
import { registerContentTools } from './tools/content'
import { registerQuickNewsTools } from './tools/quick-news'
import { registerTopologyTools } from './tools/topology'
import { SITE_URL } from './utils'

function createServer(env: Env, route: string) {
  const topology = route === '/infra/mcp'
  const quickNews = route === '/quick-news/mcp'
  let name = 'Estéban\'s MCP Server for soubiran.dev'
  if (quickNews)
    name = 'Estéban\'s Quick News MCP'
  else if (topology)
    name = 'Estéban\'s Infrastructure Topology MCP'

  const server = new McpServer({
    name,
    version: '1.0.0',
  })

  if (quickNews)
    registerQuickNewsTools(server, env)
  else if (topology)
    registerTopologyTools(server, env)
  else
    registerContentTools(server, env)

  return server
}

function isMcpRoute(path: string) {
  return path === '/mcp' || path === '/infra/mcp' || path === '/quick-news/mcp'
}

export default Sentry.withSentry(
  env => ({
    dsn: env.SENTRY_DSN,
    dataCollection: {
      userInfo: false,
      httpBodies: [],
    },
  }),
  {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
      const url = new URL(request.url)
      const startedAt = performance.now()
      const log = createWorkersLogger(request, { executionCtx: ctx })

      let response: Response
      let outcome: 'success' | 'http_error' | 'internal_error'

      try {
        if (url.pathname === '/.well-known/openai-apps-challenge') {
          response = new Response('TDwUyOcyufhOWyEr7ZNrPlWMP07hOvF5528GqXCk6Mk', {
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          })
        }
        else if (isMcpRoute(url.pathname)) {
          response = await createMcpHandler(createServer(env, url.pathname), {
            corsOptions: { origin: env.CORS_ALLOWED_ORIGIN },
            route: url.pathname,
          })(request, env, ctx)
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
        mcp: { route: isMcpRoute(url.pathname), outcome },
      })
      log.emit()
      return response
    },
  } satisfies ExportedHandler<Env>,
)
