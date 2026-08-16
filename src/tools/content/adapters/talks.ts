import type { ContentAdapter } from '../types'
import { ofetch } from 'ofetch'
import { z } from 'zod'
import { ContentDirectoryError, ContentRetrievalError, ContentUnavailableError } from '../errors'

const talkSchema = z.object({
  id: z.string().min(1),
  type: z.literal('talk'),
  title: z.string().min(1),
  description: z.string().optional(),
  date: z.string().min(1),
  url: z.url(),
  language: z.string().min(1),
  topics: z.array(z.string()),
  event: z.object({
    name: z.string().min(1),
    url: z.url(),
    location: z.object({ city: z.string().min(1), country: z.string().min(1) }).strict(),
  }).strict(),
  links: z.object({
    slides: z.url(),
    source: z.url(),
    pdf: z.url(),
    recording: z.url().optional(),
    audio: z.url().optional(),
    transcript: z.url().optional(),
    article: z.url().optional(),
  }).strict(),
}).strict()

export const talksCatalogSchema = z.object({
  schemaVersion: z.string().min(1),
  generatedAt: z.string().min(1),
  site: z.object({ id: z.string().min(1), url: z.url() }).strict(),
  data: z.array(talkSchema),
}).strict()
export type TalksCatalog = z.infer<typeof talksCatalogSchema>
export type Talk = z.infer<typeof talkSchema>

export function talkTopics(catalog: TalksCatalog) {
  return [...new Set(catalog.data.flatMap(talk => talk.topics))].sort((a, b) => a.localeCompare(b))
}

export const talksAdapter: ContentAdapter<TalksCatalog, Talk> = {
  category: 'talks',
  instanceId: 'talks',
  async load(baseUrl) {
    try {
      return talksCatalogSchema.parse(await ofetch(baseUrl, { headers: { Accept: 'application/json' } }))
    }
    catch (cause) {
      throw new ContentDirectoryError({ category: 'talks', cause, message: 'The talks directory returned an unexpected response.' })
    }
  },
  entries: catalog => catalog.data,
  findById: (catalog, id) => catalog.data.find(talk => talk.id === id),
  findBySource(catalog, source) {
    return catalog.data.find((talk) => {
      try {
        const normalized = new URL(source).toString()
        return talk.url === normalized || Object.values(talk.links).includes(normalized)
      }
      catch {
        return false
      }
    })
  },
  format: talk => ({
    id: talk.id,
    title: talk.title,
    url: talk.url,
    date: talk.date,
    language: talk.language,
    topics: talk.topics,
    event: talk.event.name,
  }),
  async retrieve(talk) {
    if (!talk.links.transcript) {
      throw new ContentUnavailableError({ message: `No transcript is available for "${talk.id}".` })
    }

    try {
      return await ofetch(talk.links.transcript, { headers: { Accept: 'text/markdown, text/plain;q=0.9' }, responseType: 'text' })
    }
    catch (cause) {
      throw new ContentRetrievalError({ category: 'talks', cause })
    }
  },
}
