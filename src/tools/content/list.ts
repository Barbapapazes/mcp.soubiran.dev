import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as Sentry from '@sentry/cloudflare'
import { z } from 'zod'
import { createToolLogger, recordTool } from '../../telemetry'
import { errorResult, textResult } from '../../utils'
import { loadContentDirectories } from './adapters'
import { executeContentCode } from './code-mode'
import { ContentCodeExecutionError, ContentCodeExecutorError } from './errors'

function contentTypes(topics: readonly string[]) {
  return `
Available data:
type Page = {
  id: string
  type: "page" | "post" | "series" | "episode"
  title: string
  description?: string
  language: string
  slug: string
  url: string
  date?: string // ISO date, for posts, series, and episodes
  translations?: Record<string, { id: string, url: string }>
  part?: number // episode number
  series?: { id: string, url: string } // for episodes
  episodeCount?: number // for series
  episodes?: { id: string, title: string, url: string, part: number }[] // for series
}

type Talk = {
  id: string
  type: "talk"
  title: string
  description?: string
  date: string // ISO date
  url: string
  language: string
  topics: string[]
  event: { name: string, url: string, location: { city: string, country: string } }
  links: { slides: string, source: string, pdf: string, recording?: string, audio?: string, transcript?: string, article?: string }
}

type Catalog<T> = {
  schemaVersion: string
  generatedAt: string // ISO date-time
  site: { id: string, url: string }
  data: T[]
}

type PagesCatalog = Catalog<Page>
type TalksCatalog = Catalog<Talk>

type EcosystemNode = {
  type: string
  id?: string
  name: string
  description?: string
  href?: string
  ecosystem?: EcosystemNode[]
}

type InfraPage = {
  id: string
  type: string
  title: string
  description?: string
  language: string
  url: string
  ecosystem?: EcosystemNode[]
  links?: unknown
}

const pages: PagesCatalog
const talks: TalksCatalog
const infra: Catalog<InfraPage>

Current talk topics: ${topics.join(', ') || 'none'}.`
}

function contentHelpers() {
  return `
Useful helpers (define these inside your async arrow function as needed):

// Combine all directory entries while retaining their category.
const allContent = () => [
  ...pages.data.map(item => ({ category: 'pages', ...item })),
  ...talks.data.map(item => ({ category: 'talks', ...item })),
  ...infra.data.map(item => ({ category: 'infra', ...item })),
]

// Filter dated pages or talks to a date range and sort newest first.
const newestFirst = items => [...items].filter(item => item.date).sort((a, b) => b.date.localeCompare(a.date))
const betweenDates = (items, from, to) => items.filter(item => item.date >= from && item.date <= to)

// Recursively search infra's ecosystem relationship tree.
const ecosystemNodes = nodes => nodes.flatMap(node => [node, ...ecosystemNodes(node.ecosystem ?? [])])

Examples:
- Recent content titles: \`async () => newestFirst([...pages.data, ...talks.data]).slice(0, 10).map(({ id, title, date }) => ({ id, title, date }))\`
- Talks about a topic: \`async () => talks.data.filter(talk => talk.topics.includes('TypeScript'))\`
- Infra relationships: \`async () => infra.data.flatMap(page => ecosystemNodes(page.ecosystem ?? []).map(node => ({ page: page.title, ...node })))\`
`
}

export function listContentDescription(topics: readonly string[]) {
  return `Query the complete source directories with a read-only async JavaScript arrow function.

${contentTypes(topics)}

${contentHelpers()}

Your code must be a single async arrow function and return a JSON-serializable value. The data is recursively frozen. Code has no network, secrets, storage, or Worker bindings.`
}

export function registerListContentTool(server: McpServer, env: Env, topics: readonly string[]) {
  server.registerTool(
    'list_content',
    {
      description: listContentDescription(topics),
      annotations: { title: 'List content with code', readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        code: z.string().trim().min(1).max(20_000).describe('An async JavaScript arrow function with read-only pages, talks, and infra globals.'),
      },
    },
    async ({ code }) => {
      const startedAt = performance.now()
      const log = createToolLogger()
      let directories
      try {
        directories = await loadContentDirectories(env)
      }
      catch (error) {
        Sentry.captureException(error)
        recordTool(log, 'list_content', startedAt, 'upstream_error', { errorCode: 'CONTENT_DIRECTORY_RETRIEVAL_FAILED' })
        return errorResult('Unable to retrieve the content directories.')
      }

      try {
        const executionStartedAt = performance.now()
        const resultJson = await executeContentCode(env.CONTENT_LOADER, directories, code)
        recordTool(log, 'list_content', startedAt, 'success', {
          input: { codeLength: code.length },
          upstream: { service: 'dynamic-worker-loader', durationMs: Math.round(performance.now() - executionStartedAt) },
          result: { contentBytes: new TextEncoder().encode(resultJson).byteLength },
        })
        return textResult(resultJson)
      }
      catch (error) {
        if (ContentCodeExecutionError.is(error)) {
          recordTool(log, 'list_content', startedAt, 'client_error', { input: { codeLength: code.length }, errorCode: 'CONTENT_CODE_EXECUTION_FAILED' })
          return errorResult(error.message)
        }

        Sentry.captureException(error)
        const executorError = ContentCodeExecutorError.is(error) ? error : new ContentCodeExecutorError({ cause: error })
        recordTool(log, 'list_content', startedAt, 'upstream_error', { input: { codeLength: code.length }, errorCode: 'CONTENT_CODE_EXECUTOR_FAILED' })
        return errorResult(`Unable to execute code against the content directories: ${executorError.message}`)
      }
    },
  )
}
