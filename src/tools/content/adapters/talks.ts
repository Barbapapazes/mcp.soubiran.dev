import type { ContentAdapter } from '../types'
import { ofetch } from 'ofetch'
import { z } from 'zod'
import { ContentDirectoryError, ContentRetrievalError, ContentUnavailableError } from '../errors'

const talkLocationSchema = z.object({
  city: z.string().min(1),
  country: z.string().min(1),
  latitude: z.number(),
  longitude: z.number(),
}).strict()

export const talkSchema = z.object({
  prefix: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  date: z.string().min(1),
  url: z.url(),
  language: z.string().min(1),
  topics: z.array(z.string()),
  event: z.string().min(1),
  event_url: z.url(),
  folder: z.string().min(1),
  location: talkLocationSchema,
  thumbnail_url: z.url(),
  thumbnail_dark_url: z.url(),
  pdf_url: z.url(),
  github_url: z.url(),
  recording_url: z.url().optional(),
  audio_url: z.url().optional(),
  transcript_url: z.url().optional(),
  article_url: z.url().optional(),
}).strict()

export const talksCatalogSchema = z.object({
  data: z.array(talkSchema),
}).loose()
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
    try {
      return talksCatalogSchema.parse(await ofetch(baseUrl, { headers: { Accept: 'application/json' } }))
    }
    catch (cause) {
      throw new ContentDirectoryError({ category: 'talks', cause, message: 'The talks directory returned an unexpected response.' })
    }
  },
  entries: catalog => catalog.data,
  findById: (catalog, id) => catalog.data.find(talk => talk.prefix === id),
  format: talk => ({
    id: talk.prefix,
    title: talk.name,
    url: talk.url,
    date: talk.date,
    language: talk.language,
    topics: talk.topics,
    event: talk.event,
  }),
  async retrieve(talk) {
    if (!talk.transcript_url) {
      throw new ContentUnavailableError({ message: `No transcript is available for "${talk.prefix}".` })
    }

    try {
      return await ofetch(transcriptUrl(talk), { headers: { Accept: 'text/markdown, text/plain;q=0.9' }, responseType: 'text' })
    }
    catch (cause) {
      throw new ContentRetrievalError({ category: 'talks', cause })
    }
  },
}
