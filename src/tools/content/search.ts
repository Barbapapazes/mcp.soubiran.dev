import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Page } from './pages'
import * as Sentry from '@sentry/cloudflare'
import { z } from 'zod'
import { createToolLogger, recordTool } from '../../telemetry'
import { errorResult, textResult } from '../../utils'
import { errorMessage } from './errors'
import { loadPages, searchInstanceId } from './pages'

export function registerSearchContentTool(server: McpServer, env: Env) {
  server.registerTool(
    'search_content',
    {
      description: 'Search all English and French pages semantically. Results are ranked excerpts with page metadata and a stable ID suitable for get_content.',
      annotations: { title: 'Search content', readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        query: z.string().trim().min(1).describe('Natural-language topic or question to search.'),
      },
    },
    async ({ query }) => {
      const startedAt = performance.now()
      const log = createToolLogger()
      const searchStartedAt = performance.now()
      const [search, pages] = await Promise.allSettled([
        env.AI_SEARCH.search({ query, ai_search_options: {
          instance_ids: [searchInstanceId],
          retrieval: { max_num_results: 20, match_threshold: 0.6 },
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
      const results: { score: number, excerpt: string, source: string, content: Page, metadata?: Record<string, unknown> }[] = []
      for (const chunk of search.value.chunks) {
        if (chunk.instance_id !== searchInstanceId)
          continue
        const id = chunk.item.metadata?.id
        if (typeof id !== 'string')
          continue
        const page = pagesById.get(id)
        if (!page)
          continue

        results.push({
          score: chunk.score,
          excerpt: chunk.text,
          source: chunk.item.key,
          content: page,
          metadata: chunk.item.metadata,
        })
      }

      recordTool(log, 'search_content', startedAt, 'success', {
        input: { queryLength: query.length, instanceIds: [searchInstanceId] },
        upstream: { service: 'cloudflare-ai-search', durationMs: Math.round(performance.now() - searchStartedAt) },
        result: { count: results.length, warnings: warnings.length },
      })

      if (results.length === 0 && warnings.length === 0)
        return textResult('No matching content was found.')

      return textResult(JSON.stringify({ results, ...(warnings.length > 0 ? { warnings } : {}) }, undefined, 2))
    },
  )
}
