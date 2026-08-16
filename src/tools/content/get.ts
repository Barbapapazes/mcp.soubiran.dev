import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as Sentry from '@sentry/cloudflare'
import { z } from 'zod'
import { createToolLogger, recordTool } from '../../telemetry'
import { errorResult, textResult } from '../../utils'
import { infraAdapter, loadContentDirectories, pagesAdapter, talksAdapter } from './adapters'
import { ContentDirectoryContractError, ContentNotFoundError, ContentUnavailableError } from './errors'

async function retrieveContent(category: 'pages' | 'talks' | 'infra', entry: unknown) {
  switch (category) {
    case 'pages': return pagesAdapter.retrieve(entry as Parameters<typeof pagesAdapter.retrieve>[0])
    case 'talks': return talksAdapter.retrieve(entry as Parameters<typeof talksAdapter.retrieve>[0])
    case 'infra': return infraAdapter.retrieve(entry as Parameters<typeof infraAdapter.retrieve>[0])
  }
}

export function registerGetContentTool(server: McpServer, env: Env) {
  server.registerTool(
    'get_content',
    {
      description: 'Retrieve one complete content document by its globally unique ID. Use search_content or list_content to discover an ID.',
      annotations: { title: 'Get content', readOnlyHint: true, openWorldHint: true },
      inputSchema: { id: z.string().trim().min(1).describe('Exact globally unique content ID returned by search_content or list_content.') },
    },
    async ({ id }) => {
      const startedAt = performance.now()
      const log = createToolLogger()
      let directories
      try {
        directories = await loadContentDirectories(env)
      }
      catch (error) {
        Sentry.captureException(error)
        recordTool(log, 'get_content', startedAt, 'upstream_error', { errorCode: 'CONTENT_DIRECTORY_RETRIEVAL_FAILED' })
        return errorResult('Unable to retrieve the content directories.')
      }

      const matches = [
        { adapter: pagesAdapter, directory: directories.pages, entry: pagesAdapter.findById(directories.pages, id) },
        { adapter: talksAdapter, directory: directories.talks, entry: talksAdapter.findById(directories.talks, id) },
        { adapter: infraAdapter, directory: directories.infra, entry: infraAdapter.findById(directories.infra, id) },
      ].filter(match => match.entry !== undefined)

      if (matches.length === 0) {
        const error = new ContentNotFoundError({ id })
        recordTool(log, 'get_content', startedAt, 'client_error', { errorCode: 'CONTENT_NOT_FOUND' })
        return errorResult(error.message)
      }

      if (matches.length > 1) {
        const error = new ContentDirectoryContractError({ message: `Content ID "${id}" appears in multiple directories.` })
        Sentry.captureException(error)
        recordTool(log, 'get_content', startedAt, 'upstream_error', { errorCode: 'DUPLICATE_CONTENT_ID' })
        return errorResult('The content directories contain a duplicate ID and cannot be resolved safely.')
      }

      const match = matches[0]!
      try {
        const content = await retrieveContent(match.adapter.category, match.entry)
        recordTool(log, 'get_content', startedAt, 'success', {
          source: { category: match.adapter.category },
          result: { contentBytes: new TextEncoder().encode(content).byteLength },
        })
        return textResult(content)
      }
      catch (error) {
        if (ContentUnavailableError.is(error)) {
          recordTool(log, 'get_content', startedAt, 'client_error', { source: { category: match.adapter.category }, errorCode: 'CONTENT_UNAVAILABLE' })
          return errorResult(error.message)
        }

        Sentry.captureException(error)
        recordTool(log, 'get_content', startedAt, 'upstream_error', { source: { category: match.adapter.category }, errorCode: 'CONTENT_RETRIEVAL_FAILED' })
        return errorResult(`Unable to retrieve the ${match.adapter.category} content.`)
      }
    },
  )
}
