import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Page } from './pages'
import * as Sentry from '@sentry/cloudflare'
import { z } from 'zod'
import { createToolLogger, recordTool } from '../../telemetry'
import { errorResult, textResult } from '../../utils'
import { errorMessage } from './errors'
import { loadPages, searchInstanceId } from './pages'

const maxSearchResults = 8
const maxExcerptCharacters = 1200

type SearchPage = Pick<Page, 'id' | 'locale' | 'type' | 'title' | 'url' | 'date'>

function summarizeExcerpt(text: string): string {
  const characters = Array.from(text.trim())
  if (characters.length <= maxExcerptCharacters)
    return characters.join('')

  return `${characters.slice(0, maxExcerptCharacters - 1).join('').trimEnd()}…`
}

export function registerSearchContentTool(server: McpServer, env: Env) {
  server.registerTool(
    'search_content',
    {
      description: 'Discover relevant English and French content by topic across titles, descriptions, and body text using Cloudflare AI Search. Prefer a short topic query such as "Cloudflare"; put language and page-kind constraints in locale and type, not in the query. Returns up to limit unique pages (default eight), with the highest-ranked excerpt per page (up to 1,200 characters), citation metadata, and a stable ID for get_page. Locale and type are checked against the published directory, not chunk metadata. Filtering applies to a bounded set of retrieved candidates, so results are not exhaustive and an empty result does not prove absence from the site. Use get_page to read the full page before summarizing it. Use list_pages for exact metadata filtering, counts, series, or latest-page/date comparisons; search ranking does not establish recency.',
      annotations: { title: 'Search content', readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        query: z.string().trim().min(1).max(1000).describe('Short topic or question, for example "Cloudflare Workers". Do not include output-format instructions or metadata filters.'),
        locale: z.enum(['en', 'fr']).optional().describe('Only return pages in this locale; omit to search both languages.'),
        type: z.string().trim().min(1).max(100).optional().describe('Exact published page type, such as post, talk, page, series, or series_article. This is not the index chunk kind.'),
        limit: z.number().int().min(1).max(maxSearchResults).optional().describe('Maximum distinct pages to return (1–8; default 8). Use the smallest limit needed.'),
      },
    },
    async ({ query, locale, type, limit = maxSearchResults }) => {
      const startedAt = performance.now()
      const log = createToolLogger()
      const searchStartedAt = performance.now()
      const [search, pages] = await Promise.allSettled([
        env.AI_SEARCH.search({ query, ai_search_options: {
          instance_ids: [searchInstanceId],
          retrieval: { max_num_results: 20, match_threshold: 0.6, return_on_failure: false },
          reranking: { enabled: true, model: '@cf/baai/bge-reranker-base' },
        } }),
        loadPages(env),
      ])

      if (search.status === 'rejected') {
        Sentry.captureException(search.reason)
        recordTool(log, 'search_content', startedAt, 'upstream_error', { errorCode: 'CONTENT_SEARCH_FAILED' })
        return errorResult(`Unable to search content: ${errorMessage(search.reason)}`)
      }
      if (pages.status === 'rejected') {
        Sentry.captureException(pages.reason)
        recordTool(log, 'search_content', startedAt, 'upstream_error', { errorCode: 'CONTENT_DIRECTORY_RETRIEVAL_FAILED' })
        return errorResult('Unable to retrieve the pages to resolve search results.')
      }

      const warnings = (search.value.errors ?? []).map(error => `Search failed for ${error.instance_id}: ${error.message}`)
      const pagesById = new Map(pages.value.map(page => [page.id, page]))
      const results: { score: number, excerpt: string, content: SearchPage }[] = []
      const seenPageIds = new Set<string>()
      const chunks = [...search.value.chunks].sort((a, b) => b.score - a.score)
      for (const chunk of chunks) {
        if (chunk.instance_id !== searchInstanceId)
          continue
        const id = chunk.item.metadata?.id
        if (typeof id !== 'string')
          continue
        const page = pagesById.get(id)
        if (!page || seenPageIds.has(id) || (locale && page.locale !== locale) || (type && page.type !== type))
          continue

        seenPageIds.add(id)
        results.push({
          score: chunk.score,
          excerpt: summarizeExcerpt(chunk.text),
          content: {
            id: page.id,
            locale: page.locale,
            type: page.type,
            title: page.title,
            url: page.url,
            ...(page.date ? { date: page.date } : {}),
          },
        })
        if (results.length >= limit)
          break
      }

      recordTool(log, 'search_content', startedAt, 'success', {
        input: { queryLength: query.length, instanceIds: [searchInstanceId], ...(locale ? { locale } : {}), ...(type ? { type } : {}), limit },
        upstream: { service: 'cloudflare-ai-search', durationMs: Math.round(performance.now() - searchStartedAt) },
        result: { count: results.length, warnings: warnings.length },
      })

      if (results.length === 0 && warnings.length === 0)
        return textResult('No matching pages were returned for this query and filters. This does not establish that no such content exists on the site.')

      return textResult(JSON.stringify({ results, ...(warnings.length > 0 ? { warnings } : {}) }))
    },
  )
}
