import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Page } from './utils'
import * as Sentry from '@sentry/cloudflare'
import { z } from 'zod'
import { createToolLogger, recordTool } from '../telemetry'
import { errorResult, textResult } from '../utils'
import { findPageFromSource, formatPage, getPages, getScope, searchPageContent } from './utils'

export function registerSearchPagesTool(server: McpServer, env: Env) {
  server.registerTool(
    'search_pages',
    {
      description: 'Discover English pages on soubiran.dev. Call without a query to browse the available page directory, or provide a natural-language query to semantically search page content. Results include each page\'s path, which can be passed to get_page to retrieve its full Markdown. French pages are not available.',
      annotations: {
        title: 'Search pages',
        readOnlyHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        query: z.string().trim().min(1).optional().describe('Optional natural-language topic or question to search within page content. Omit this field to list all available pages.'),
        scope: z.enum(['blog', 'series']).optional().describe('Optional result filter: "blog" returns posts only; "series" returns series pages only. Omit to search or list both.'),
      },
    },
    async ({ query, scope }) => {
      const startedAt = performance.now()
      const log = createToolLogger()
      const pagesResult = await getPages(env.BASE_URL)

      if (pagesResult.isErr()) {
        Sentry.captureException(pagesResult.error)
        recordTool(log, 'search_pages', startedAt, 'upstream_error', { errorCode: 'PAGE_SEARCH_FAILED' })
        return errorResult(`Unable to search pages: ${pagesResult.error.message}`)
      }

      const scopedPages = scope ? pagesResult.value.filter(page => getScope(page.uri) === scope) : pagesResult.value

      if (!query) {
        recordTool(log, 'search_pages', startedAt, 'success', {
          input: { hasQuery: false, scope },
          result: { count: scopedPages.length },
        })
        return textResult(JSON.stringify(scopedPages.map(formatPage), undefined, 2))
      }

      const pagesByPath = new Map(scopedPages.map(page => [page.uri, page]))
      const searchStartedAt = performance.now()
      const searchResult = await searchPageContent(env.AI_SEARCH, query)

      if (searchResult.isErr()) {
        Sentry.captureException(searchResult.error)
        recordTool(log, 'search_pages', startedAt, 'upstream_error', { errorCode: 'PAGE_SEARCH_FAILED' })
        return errorResult(`Unable to search pages: ${searchResult.error.message}`)
      }

      const matchedPages = new Map<string, { page: Page, score: number, excerpt: string }>()

      for (const chunk of searchResult.value.chunks) {
        const pageResult = findPageFromSource(chunk.item.key, pagesByPath)
        if (pageResult.isErr())
          continue

        const page = pageResult.value
        const current = matchedPages.get(page.uri)
        if (!current || chunk.score > current.score) {
          matchedPages.set(page.uri, {
            page,
            score: chunk.score,
            excerpt: chunk.text,
          })
        }
      }

      const matches = [...matchedPages.values()]
        .sort((a, b) => b.score - a.score)
        .map(({ page, score, excerpt }) => ({ ...formatPage(page), score, excerpt }))

      recordTool(log, 'search_pages', startedAt, 'success', {
        input: { hasQuery: true, queryLength: query.length, scope },
        upstream: { service: 'cloudflare-ai-search', durationMs: Math.round(performance.now() - searchStartedAt) },
        result: { count: matches.length, empty: matches.length === 0 },
      })

      if (matches.length === 0)
        return textResult('No matching English pages were found.')

      return textResult(JSON.stringify(matches, undefined, 2))
    },
  )
}
