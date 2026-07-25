import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as Sentry from '@sentry/cloudflare'
import { createMcpHandler } from 'agents/mcp'
import { createWorkersLogger } from 'evlog/workers'
import { registerGetPageTool } from './tools/get-page'
import { registerSearchPagesTool } from './tools/search-pages'

function createServer(env: Env) {
  const server = new McpServer({
    name: 'Estéban\'s MCP Server for soubiran.dev',
    version: '1.0.0',
  })

  registerGetPageTool(server, env)
  registerSearchPagesTool(server, env)

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

      try {
        response = url.pathname === '/mcp'
          ? await createMcpHandler(createServer(env), { route: '/mcp' })(request, env, ctx)
          : Response.redirect('https://soubiran.dev', 302)
      }
      catch (error) {
        Sentry.captureException(error)
        log.setLevel('error')
        log.set({ mcp: { outcome: 'internal_error', errorCode: 'MCP_HANDLER_FAILED' } })
        log.emit()
        response = new Response('Internal Server Error', { status: 500 })
      }

      log.set({
        request: { durationMs: Math.round(performance.now() - startedAt) },
        mcp: { route: url.pathname === '/mcp', outcome: response.ok ? 'success' : 'http_error' },
      })
      log.emit()
      return response
    },
  } satisfies ExportedHandler<Env>,
)
