import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as Sentry from '@sentry/cloudflare'
import { z } from 'zod'
import { createToolLogger, recordTool } from '../../telemetry'
import { errorResult, textResult } from '../../utils'
import { loadPages, retrievePage } from './pages'

export function registerGetPageTool(server: McpServer, env: Env) {
  server.registerTool(
    'get_page',
    {
      description: 'Read one complete page as Markdown by its globally unique ID. Use search_content to discover relevant content or list_pages to find an exact title, series, or latest page. Read the full page before summarizing it; use its published URL from discovery results to cite the source.',
      annotations: { title: 'Get page', readOnlyHint: true, openWorldHint: true },
      inputSchema: { id: z.string().trim().min(1).describe('Exact globally unique page ID returned by search_content or list_pages.') },
    },
    async ({ id }) => {
      const startedAt = performance.now()
      const log = createToolLogger()
      let pages
      try {
        pages = await loadPages(env)
      }
      catch (error) {
        Sentry.captureException(error)
        recordTool(log, 'get_page', startedAt, 'upstream_error', { errorCode: 'CONTENT_DIRECTORY_RETRIEVAL_FAILED' })
        return errorResult('Unable to retrieve the pages.')
      }

      const page = pages.find(page => page.id === id)
      if (!page) {
        recordTool(log, 'get_page', startedAt, 'client_error', { errorCode: 'CONTENT_NOT_FOUND' })
        return errorResult(`No content matches "${id}". Use search_content or list_pages to find an exact ID.`)
      }

      try {
        const content = await retrievePage(page)
        recordTool(log, 'get_page', startedAt, 'success', {
          source: { category: 'pages' },
          result: { contentBytes: new TextEncoder().encode(content).byteLength },
        })
        return textResult(content)
      }
      catch (error) {
        Sentry.captureException(error)
        recordTool(log, 'get_page', startedAt, 'upstream_error', { source: { category: 'pages' }, errorCode: 'CONTENT_RETRIEVAL_FAILED' })
        return errorResult('Unable to retrieve the page content.')
      }
    },
  )
}
