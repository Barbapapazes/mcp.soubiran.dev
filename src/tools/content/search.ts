import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ContentCategory, ContentSearchResult } from './types'
import * as Sentry from '@sentry/cloudflare'
import { z } from 'zod'
import { createToolLogger, recordTool } from '../../telemetry'
import { errorResult, textResult } from '../../utils'
import { categoriesByInstanceId, contentAdapters } from './adapters'
import { ContentDirectoryError, ContentSearchError } from './errors'

const categorySchema = z.enum(['pages', 'talks', 'infra'])

async function loadDirectory(env: Env, category: ContentCategory) {
  const adapter = contentAdapters[category]
  switch (category) {
    case 'pages': return adapter.load(env.PAGES_BASE_URL)
    case 'talks': return adapter.load(env.TALKS_BASE_URL)
    case 'infra': return adapter.load(env.INFRA_BASE_URL)
  }
}

function findFromSource(category: ContentCategory, directory: unknown, source: string) {
  switch (category) {
    case 'pages': return contentAdapters.pages.findBySource(directory as Parameters<typeof contentAdapters.pages.findBySource>[0], source)
    case 'talks': return contentAdapters.talks.findBySource(directory as Parameters<typeof contentAdapters.talks.findBySource>[0], source)
    case 'infra': return contentAdapters.infra.findBySource(directory as Parameters<typeof contentAdapters.infra.findBySource>[0], source)
  }
}

function format(category: ContentCategory, entry: unknown) {
  switch (category) {
    case 'pages': return contentAdapters.pages.format(entry as Parameters<typeof contentAdapters.pages.format>[0])
    case 'talks': return contentAdapters.talks.format(entry as Parameters<typeof contentAdapters.talks.format>[0])
    case 'infra': return contentAdapters.infra.format(entry as Parameters<typeof contentAdapters.infra.format>[0])
  }
}

export function registerSearchContentTool(server: McpServer, env: Env) {
  server.registerTool(
    'search_content',
    {
      description: 'Search pages, talks, and infra content semantically. Results are ranked excerpts with a category and stable ID suitable for get_content.',
      annotations: { title: 'Search content', readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        query: z.string().trim().min(1).describe('Natural-language topic or question to search.'),
        category: categorySchema.optional().describe('Optionally restrict search to pages, talks, or infra.'),
      },
    },
    async ({ query, category }) => {
      const startedAt = performance.now()
      const log = createToolLogger()
      const categories = category ? [category] : [...categorySchema.options]
      const instanceIds = categories.map(item => contentAdapters[item].instanceId)
      const searchStartedAt = performance.now()
      const [search, directories] = await Promise.allSettled([
        env.AI_SEARCH.search({ query, ai_search_options: { instance_ids: instanceIds, retrieval: { max_num_results: 20 } } }),
        Promise.allSettled(categories.map(async item => [item, await loadDirectory(env, item)] as const)),
      ])

      if (search.status === 'rejected') {
        const error = new ContentSearchError({ cause: search.reason })
        Sentry.captureException(error)
        recordTool(log, 'search_content', startedAt, 'upstream_error', { errorCode: 'CONTENT_SEARCH_FAILED' })
        return errorResult(`Unable to search content: ${error.message}`)
      }

      const warnings: string[] = []
      const directoryMap = new Map<ContentCategory, unknown>()
      if (directories.status === 'fulfilled') {
        for (const [index, directory] of directories.value.entries()) {
          if (directory.status === 'fulfilled') {
            const [item, value] = directory.value
            directoryMap.set(item, value)
            continue
          }

          const failedCategory = categories[index]!
          const error = directory.reason instanceof ContentDirectoryError
            ? directory.reason
            : new ContentDirectoryError({ category: failedCategory, cause: directory.reason })
          if (category) {
            Sentry.captureException(error)
            recordTool(log, 'search_content', startedAt, 'upstream_error', { errorCode: 'CONTENT_DIRECTORY_RETRIEVAL_FAILED' })
            return errorResult(`Unable to retrieve the ${failedCategory} directory: ${error.message}`)
          }
          Sentry.captureException(error)
          warnings.push(`The ${failedCategory} directory was unavailable, so its search hits could not be enriched with stable IDs.`)
        }
      }
      else if (category) {
        const error = directories.reason instanceof ContentDirectoryError ? directories.reason : new ContentDirectoryError({ category, cause: directories.reason })
        Sentry.captureException(error)
        recordTool(log, 'search_content', startedAt, 'upstream_error', { errorCode: 'CONTENT_DIRECTORY_RETRIEVAL_FAILED' })
        return errorResult(`Unable to retrieve the ${category} directory: ${error.message}`)
      }
      else {
        warnings.push('One or more content directories were unavailable, so some search hits could not be enriched with stable IDs.')
        Sentry.captureException(directories.reason)
      }

      for (const error of search.value.errors ?? []) {
        const failedCategory = categoriesByInstanceId.get(error.instance_id)
        const message = failedCategory ? `Search failed for ${failedCategory}: ${error.message}` : `Search failed for unknown instance ${error.instance_id}: ${error.message}`
        if (category) {
          recordTool(log, 'search_content', startedAt, 'upstream_error', { errorCode: 'CONTENT_SEARCH_INSTANCE_FAILED' })
          return errorResult(message)
        }
        warnings.push(message)
      }

      const results: ContentSearchResult[] = []
      for (const chunk of search.value.chunks) {
        const hitCategory = categoriesByInstanceId.get(chunk.instance_id)
        if (!hitCategory || !directoryMap.has(hitCategory))
          continue

        const entry = findFromSource(hitCategory, directoryMap.get(hitCategory), chunk.item.key)
        if (!entry)
          continue

        results.push({
          score: chunk.score,
          excerpt: chunk.text,
          source: chunk.item.key,
          category: hitCategory,
          content: format(hitCategory, entry),
          ...(chunk.item.metadata ? { metadata: chunk.item.metadata } : {}),
        })
      }

      recordTool(log, 'search_content', startedAt, 'success', {
        input: { queryLength: query.length, category, instanceIds },
        upstream: { service: 'cloudflare-ai-search', durationMs: Math.round(performance.now() - searchStartedAt) },
        result: { count: results.length, warnings: warnings.length },
      })

      if (results.length === 0 && warnings.length === 0)
        return textResult('No matching content was found.')

      return textResult(JSON.stringify({ results, ...(warnings.length > 0 ? { warnings } : {}) }, undefined, 2))
    },
  )
}
