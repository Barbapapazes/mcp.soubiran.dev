import type { ContentAdapter } from '../types'
import { ofetch } from 'ofetch'
import { z } from 'zod'
import { ContentRetrievalError, ContentUnavailableError } from '../errors'
import { loadDirectory } from './load'

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

function transcriptUrl(talk: Talk) {
  const documentUrl = new URL(talk.url)
  documentUrl.pathname = `${documentUrl.pathname.replace(/\/$/, '')}/transcript.${talk.language}.md`
  return documentUrl.toString()
}

export function talkTopics(catalog: TalksCatalog) {
  return [...new Set(catalog.data.flatMap(talk => talk.topics))].sort((a, b) => a.localeCompare(b))
}

export const talksAdapter: ContentAdapter<TalksCatalog, Talk> = {
  category: 'talks',
  instanceId: 'talks',
  async load(baseUrl) {
    return loadDirectory('talks', baseUrl, talksCatalogSchema)
  },
  entries: catalog => catalog.data,
  findById: (catalog, id) => catalog.data.find(talk => talk.id === id),
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
      return await ofetch(transcriptUrl(talk), { headers: { Accept: 'text/markdown, text/plain;q=0.9' }, responseType: 'text' })
    }
    catch (cause) {
      throw new ContentRetrievalError({ category: 'talks', cause })
    }
  },
}
