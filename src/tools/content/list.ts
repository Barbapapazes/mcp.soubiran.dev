import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as Sentry from '@sentry/cloudflare'
import { z } from 'zod'
import { createToolLogger, recordTool } from '../../telemetry'
import { errorResult, textResult } from '../../utils'
import { executeContentCode } from './code-mode'
import { ContentCodeExecutionError, errorMessage } from './errors'
import { loadPages } from './pages'

export const listPagesDescription = `Analyze metadata for all English and French pages with a read-only async JavaScript arrow function. Use this for exact titles, date comparisons (such as the latest matching post), series, counts, and filtering by locale or type. This does not search body text: use search_content for topic discovery and get_page to read a full page by ID.

Available data:
type Page = {
  id: string
  locale: "en" | "fr"
  type: string // currently page, post, talk, series, or series_article
  title: string
  description?: string
  url: string // absolute published URL
  markdownUrl: string // absolute Markdown URL
  translations?: Record<string, string> // locale to absolute published URL
  date?: string
}

const pages: Page[]

Examples:
- Recent English posts: \`async () => pages.filter(page => page.locale === 'en' && page.type === 'post' && page.date).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10).map(({ id, title, date, url }) => ({ id, title, date, url }))\`
- French talks: \`async () => pages.filter(page => page.locale === 'fr' && page.type === 'talk')\`
- Find a page by title: \`async () => pages.filter(page => page.title.toLowerCase().includes('cloudflare'))\`

Filter, sort, limit, and project only the fields needed for the question rather than returning the full catalog. Include id for get_page and url for source citations. Your code must be a single async arrow function and return a JSON-serializable value. The pages array is recursively frozen. Code has no network, secrets, storage, or Worker bindings.`

export function registerListPagesTool(server: McpServer, env: Env) {
  server.registerTool(
    'list_pages',
    {
      description: listPagesDescription,
      annotations: { title: 'List pages with code', readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        code: z.string().trim().min(1).max(20_000).describe('An async JavaScript arrow function with read-only pages array.'),
      },
    },
    async ({ code }) => {
      const startedAt = performance.now()
      const log = createToolLogger()
      let pages
      try {
        pages = await loadPages(env)
      }
      catch (error) {
        Sentry.captureException(error)
        recordTool(log, 'list_pages', startedAt, 'upstream_error', { errorCode: 'CONTENT_DIRECTORY_RETRIEVAL_FAILED' })
        return errorResult('Unable to retrieve the pages.')
      }

      try {
        const executionStartedAt = performance.now()
        const resultJson = await executeContentCode(env.CONTENT_LOADER, pages, code)
        recordTool(log, 'list_pages', startedAt, 'success', {
          input: { codeLength: code.length },
          upstream: { service: 'dynamic-worker-loader', durationMs: Math.round(performance.now() - executionStartedAt) },
          result: { contentBytes: new TextEncoder().encode(resultJson).byteLength },
        })
        return textResult(resultJson)
      }
      catch (error) {
        if (error instanceof ContentCodeExecutionError) {
          recordTool(log, 'list_pages', startedAt, 'client_error', { input: { codeLength: code.length }, errorCode: 'CONTENT_CODE_EXECUTION_FAILED' })
          return errorResult(error.message)
        }

        Sentry.captureException(error)
        recordTool(log, 'list_pages', startedAt, 'upstream_error', { input: { codeLength: code.length }, errorCode: 'CONTENT_CODE_EXECUTOR_FAILED' })
        return errorResult(`Unable to execute code against the pages: ${errorMessage(error)}`)
      }
    },
  )
}
