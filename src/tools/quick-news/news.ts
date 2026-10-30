import { z } from 'zod'
import { loadRemoteJson } from '../remote-document'

export const quickNewsSchema = z.object({
  id: z.string().min(1),
  url: z.url(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  category: z.string().nullable(),
  authors: z.array(z.string()),
  filename: z.string().regex(/^[\w-]+\.md$/),
  released_at: z.string().nullable(),
  processed_at: z.string().min(1),
  created_at: z.string(),
  discord_message_url: z.url().nullable(),
})

export type QuickNews = z.infer<typeof quickNewsSchema>

export const searchInstanceId = 'quick-news-soubiran-dev'

export function newsUrl(env: Env, path: string) {
  return `${env.QUICK_NEWS_API_URL.replace(/\/$/, '')}/${path}`
}

export async function loadNews(env: Env) {
  const catalog = await loadRemoteJson(newsUrl(env, 'catalog'), 'Quick News catalog', z.object({
    data: z.array(quickNewsSchema),
  }))
  const ids = new Set<string>()
  for (const item of catalog.data) {
    if (ids.has(item.id))
      throw new Error('The Quick News catalog contains duplicate IDs.')
    ids.add(item.id)
  }
  return catalog.data
}

export function newsCategories(news: QuickNews[]) {
  const counts = new Map<string, number>()
  for (const item of news) {
    if (item.category !== null)
      counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, published_count]) => ({ name, published_count }))
}

export async function retrieveNews(env: Env, id: string) {
  const response = await loadRemoteJson(newsUrl(env, `${encodeURIComponent(id)}/content`), 'Quick News content', z.object({
    data: quickNewsSchema.extend({ markdown: z.string() }),
  }))
  if (response.data.id !== id)
    throw new Error('The Quick News content returned a different ID.')
  return response.data
}
