import { z } from 'zod'
import { loadRemoteJson, loadRemoteText } from '../remote-document'

const pageSchema = z.object({
  id: z.string().min(1),
  locale: z.enum(['en', 'fr']),
  type: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  url: z.url(),
  markdownUrl: z.url(),
  translations: z.record(z.string(), z.url()).optional(),
  date: z.string().min(1).optional(),
}).strict()

export type Page = z.infer<typeof pageSchema>

export const searchInstanceId = 'soubiran-dev'

export async function loadPagesFeed(feedUrl: string): Promise<Page[]> {
  const resolveUrl = z.string().min(1).transform(value => new URL(value, feedUrl).toString()).pipe(z.url())
  const feedSchema = z.array(pageSchema.extend({
    url: resolveUrl,
    markdownUrl: resolveUrl,
    translations: z.record(z.string(), resolveUrl).optional(),
  }))
  return loadRemoteJson(feedUrl, 'pages feed', feedSchema)
}

export async function loadPages(env: Env) {
  const feeds = await Promise.all([
    loadPagesFeed(env.PAGES_EN_URL),
    loadPagesFeed(env.PAGES_FR_URL),
  ])
  const pages = feeds.flat()
  const ids = new Set<string>()
  for (const page of pages) {
    if (ids.has(page.id))
      throw new Error(`Content ID "${page.id}" appears in multiple pages.`)
    ids.add(page.id)
  }
  return pages
}

export function retrievePage(page: Page) {
  return loadRemoteText(page.markdownUrl, 'page Markdown', 'text/markdown, text/plain;q=0.9')
}
