import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as Sentry from '@sentry/cloudflare'
import { createMcpHandler } from 'agents/mcp'
import { createWorkersLogger } from 'evlog/workers'
import { registerContentTools } from './tools/content'
import { registerTopologyTools } from './tools/topology'
import { SITE_URL } from './utils'

function createServer(env: Env, topology: boolean) {
  const server = new McpServer({
    name: topology ? 'Estéban\'s Infrastructure Topology MCP' : 'Estéban\'s MCP Server for soubiran.dev',
    version: '1.0.0',
  })

  if (topology)
    registerTopologyTools(server, env)
  else
    registerContentTools(server, env)

  return server
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
        else if (url.pathname === '/mcp' || url.pathname === '/infra/mcp') {
          response = await createMcpHandler(createServer(env, url.pathname === '/infra/mcp'), {
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
        log.set({ mcp: { errorCode: 'MCP_HANDLER_FAILED' } })
        outcome = 'internal_error'
        response = new Response('Internal Server Error', { status: 500 })
      }

      log.set({
        request: { durationMs: Math.round(performance.now() - startedAt) },
        mcp: { route: url.pathname === '/mcp' || url.pathname === '/infra/mcp', outcome },
      })
      log.emit()
      return response
    },
  } satisfies ExportedHandler<Env>,
)
