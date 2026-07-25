import { Result } from 'better-result'
import { ofetch } from 'ofetch'
import { z } from 'zod'
import { SITE_URL } from '../utils'
import { PageDirectoryError, PageNotFoundError, PageRetrievalError, PageSearchError, PageSourceNotFoundError } from './errors'

const pageSchema = z.object({
  id: z.string(),
  title: z.string(),
  uri: z.string(),
  url: z.url(),
  date: z.string(),
})

const pageDirectorySchema = z.array(pageSchema)

export type Page = z.infer<typeof pageSchema>
export type Scope = 'blog' | 'series'

export function getScope(path: string): Scope | undefined {
  if (path.startsWith('/posts/'))
    return 'blog'

  if (path.startsWith('/series/'))
    return 'series'
}

export async function getPages(baseUrl: string) {
  return Result.tryPromise({
    try: async () => {
      const data = await ofetch(baseUrl, {
        headers: { Accept: 'application/json' },
      })
      const parsed = pageDirectorySchema.safeParse(data)
      if (!parsed.success) {
        throw new PageDirectoryError({
          cause: parsed.error,
          message: 'The page directory returned an unexpected response.',
        })
      }

      return parsed.data
    },
    catch: cause => PageDirectoryError.is(cause) ? cause : new PageDirectoryError({ cause }),
  })
}

export function normalizePath(path: string) {
  const trimmedPath = path.trim()

  if (!trimmedPath || trimmedPath.includes('?') || trimmedPath.includes('#'))
    return undefined

  if (trimmedPath.startsWith('http://') || trimmedPath.startsWith('https://'))
    return undefined

  return trimmedPath.startsWith('/') ? trimmedPath : `/${trimmedPath}`
}

export function findPage(pages: Page[], identifier: string) {
  const normalizedPath = normalizePath(identifier)
  const page = pages.find(page => page.id === identifier || page.title === identifier || page.uri === normalizedPath)

  return page ? Result.ok(page) : Result.err(new PageNotFoundError({ identifier }))
}

export function findPageFromSource(source: string, pagesByPath: Map<string, Page>) {
  return Result.try({
    try: () => new URL(source, SITE_URL).pathname,
    catch: () => new PageSourceNotFoundError({ source }),
  }).andThen((pathname) => {
    const path = `/${pathname.replace(/^\/+/, '').replace(/\.md$/, '')}`
    const page = pagesByPath.get(path)

    return page ? Result.ok(page) : Result.err(new PageSourceNotFoundError({ source }))
  })
}

export async function getPageMarkdown(page: Page) {
  const markdownUrl = new URL(`${page.uri}.md`, SITE_URL)

  return Result.tryPromise({
    try: () => ofetch(markdownUrl.toString(), {
      headers: { Accept: 'text/markdown, text/plain;q=0.9' },
      responseType: 'text',
    }),
    catch: cause => new PageRetrievalError({ cause }),
  })
}

export async function searchPageContent(aiSearch: AiSearchInstance, query: string) {
  return Result.tryPromise({
    try: () => aiSearch.search({
      query,
      ai_search_options: {
        retrieval: { max_num_results: 50 },
      },
    }),
    catch: cause => new PageSearchError({ cause }),
  })
}

export function formatPage(page: Page) {
  return {
    id: page.id,
    title: page.title,
    path: page.uri,
    url: page.url,
    date: page.date,
  }
}
