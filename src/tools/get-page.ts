import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as Sentry from '@sentry/cloudflare'
import { Result } from 'better-result'
import { z } from 'zod'
import { createToolLogger, recordTool } from '../telemetry'
import { errorResult, textResult } from '../utils'
import { PageNotFoundError } from './errors'
import { findPage, getPageMarkdown, getPages } from './utils'

export function registerGetPageTool(server: McpServer, env: Env) {
  server.registerTool(
    'get_page',
    {
      description: 'Retrieve the complete Markdown for one English soubiran.dev page. Pass the exact path returned by search_pages whenever possible; exact page titles and metadata IDs are also accepted. Use search_pages first if you need to discover a page or are unsure of its identifier. French pages are not available.',
      annotations: {
        title: 'Get page',
        readOnlyHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        path: z.string().trim().min(1).describe('Exact identifier for the page. Prefer the path returned by search_pages, such as "/posts/example" or "/series/example". An exact English title or metadata ID also works; full URLs, query strings, and fragments do not.'),
      },
    },
    async ({ path }) => {
      const startedAt = performance.now()
      const log = createToolLogger()
      let fetchStartedAt: number | undefined

      const result = await Result.gen(async function* () {
        const pages = yield* Result.await(getPages(env.BASE_URL))
        const page = yield* findPage(pages, path)
        fetchStartedAt = performance.now()
        const markdown = yield* Result.await(getPageMarkdown(page))
        return Result.ok(markdown)
      })

      if (result.isErr()) {
        if (PageNotFoundError.is(result.error)) {
          recordTool(log, 'get_page', startedAt, 'client_error', { errorCode: 'PAGE_NOT_FOUND' })
          return errorResult(result.error.message)
        }

        Sentry.captureException(result.error)
        recordTool(log, 'get_page', startedAt, 'upstream_error', { errorCode: 'PAGE_RETRIEVAL_FAILED' })
        return errorResult(`Unable to retrieve the page: ${result.error.message}`)
      }

      recordTool(log, 'get_page', startedAt, 'success', {
        upstream: { service: 'soubiran.dev', durationMs: Math.round(performance.now() - (fetchStartedAt ?? startedAt)) },
        result: { contentBytes: new TextEncoder().encode(result.value).byteLength },
      })
      return textResult(result.value)
    },
  )
}
