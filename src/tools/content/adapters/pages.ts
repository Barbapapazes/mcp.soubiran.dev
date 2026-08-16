import type { ContentAdapter } from '../types'
import { ofetch } from 'ofetch'
import { z } from 'zod'
import { ContentDirectoryError, ContentRetrievalError } from '../errors'

const translationSchema = z.object({
  id: z.string().min(1),
  url: z.url(),
}).strict()

const episodeReferenceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  url: z.url(),
  part: z.number().int().positive(),
}).strict()

export const pageSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['page', 'post', 'series', 'episode']),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  language: z.string().min(1),
  slug: z.string().min(1),
  url: z.url(),
  date: z.string().min(1).optional(),
  translations: z.record(z.string(), translationSchema).optional(),
  source: z.unknown().optional(),
  part: z.number().int().positive().optional(),
  series: z.object({ id: z.string().min(1), url: z.url() }).strict().optional(),
  subtitle: z.string().min(1).optional(),
  meetTheInstructor: z.string().min(1).optional(),
  episodeCount: z.number().int().nonnegative().optional(),
  episodes: z.array(episodeReferenceSchema).optional(),
}).strict()

export const pagesCatalogSchema = z.object({
  schemaVersion: z.string().min(1),
  generatedAt: z.string().min(1),
  site: z.object({ id: z.string().min(1), url: z.url() }).strict(),
  data: z.array(pageSchema),
}).strict()

export type Page = z.infer<typeof pageSchema>
export type PagesCatalog = z.infer<typeof pagesCatalogSchema>

export const pagesAdapter: ContentAdapter<PagesCatalog, Page> = {
  category: 'pages',
  instanceId: 'soubiran-dev',
  async load(baseUrl) {
    try {
      return pagesCatalogSchema.parse(await ofetch(baseUrl, { headers: { Accept: 'application/json' } }))
    }
    catch (cause) {
      throw new ContentDirectoryError({ category: 'pages', cause, message: 'The pages directory returned an unexpected response.' })
    }
  },
  entries: catalog => catalog.data,
  findById: (catalog, id) => catalog.data.find(entry => entry.id === id),
  findBySource(catalog, source) {
    try {
      const normalized = new URL(source).toString()
      return catalog.data.find(entry => entry.url === normalized)
    }
    catch {
      return undefined
    }
  },
  format: entry => ({
    id: entry.id,
    title: entry.title,
    url: entry.url,
    description: entry.description,
    date: entry.date,
    type: entry.type,
    language: entry.language,
  }),
  async retrieve(entry) {
    try {
      return await ofetch(entry.url, { headers: { Accept: 'text/markdown, text/plain;q=0.9' }, responseType: 'text' })
    }
    catch (cause) {
      throw new ContentRetrievalError({ category: 'pages', cause })
    }
  },
}
