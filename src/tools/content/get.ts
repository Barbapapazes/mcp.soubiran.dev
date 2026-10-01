import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as Sentry from '@sentry/cloudflare'
import { z } from 'zod'
import { createToolLogger, recordTool } from '../../telemetry'
import { errorResult, textResult } from '../../utils'
import { loadPages, retrievePage } from './pages'

export function registerGetContentTool(server: McpServer, env: Env) {
  server.registerTool(
    'get_content',
    {
      description: 'Retrieve one complete page as Markdown by its globally unique ID. Use search_content or list_content to discover an ID.',
      annotations: { title: 'Get content', readOnlyHint: true, openWorldHint: true },
      inputSchema: { id: z.string().trim().min(1).describe('Exact globally unique page ID returned by search_content or list_content.') },
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
        recordTool(log, 'get_content', startedAt, 'upstream_error', { errorCode: 'CONTENT_DIRECTORY_RETRIEVAL_FAILED' })
        return errorResult('Unable to retrieve the pages.')
      }

      const page = pages.find(page => page.id === id)
      if (!page) {
        recordTool(log, 'get_content', startedAt, 'client_error', { errorCode: 'CONTENT_NOT_FOUND' })
        return errorResult(`No content matches "${id}". Use search_content or list_content to find an exact ID.`)
      }

      try {
        const content = await retrievePage(page)
        recordTool(log, 'get_content', startedAt, 'success', {
          source: { category: 'pages' },
          result: { contentBytes: new TextEncoder().encode(content).byteLength },
        })
        return textResult(content)
      }
      catch (error) {
        Sentry.captureException(error)
        recordTool(log, 'get_content', startedAt, 'upstream_error', { source: { category: 'pages' }, errorCode: 'CONTENT_RETRIEVAL_FAILED' })
        return errorResult('Unable to retrieve the page content.')
      }
    },
  )
}
