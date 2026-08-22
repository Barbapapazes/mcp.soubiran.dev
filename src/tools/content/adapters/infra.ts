import type { ContentAdapter } from '../types'
import { ofetch } from 'ofetch'
import { z } from 'zod'
import { ContentDirectoryError, ContentRetrievalError } from '../errors'

export interface EcosystemNode {
  type: string
  id?: string
  name: string
  description?: string
  href?: string
  ecosystem?: EcosystemNode[]
}

const catalogSiteSchema = z.object({ id: z.string().min(1), url: z.url() }).strict()

const ecosystemNodeSchema: z.ZodType<EcosystemNode> = z.object({
  type: z.string().min(1),
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  href: z.string().optional(),
  ecosystem: z.lazy(() => z.array(ecosystemNodeSchema)).optional(),
}).strict()

export const infraPageSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  language: z.string().min(1),
  url: z.url(),
  ecosystem: z.array(ecosystemNodeSchema).optional(),
  links: z.unknown().optional(),
}).strict()

export type InfraPage = z.infer<typeof infraPageSchema>
export const infraCatalogSchema = z.object({
  schemaVersion: z.string().min(1),
  generatedAt: z.string().min(1),
  site: catalogSiteSchema,
  data: z.array(infraPageSchema),
}).strict()
export type InfraCatalog = z.infer<typeof infraCatalogSchema>

function markdownUrl(url: string) {
  const documentUrl = new URL(url)
  documentUrl.pathname = documentUrl.pathname === '/' ? '/index.md' : `${documentUrl.pathname.replace(/\/$/, '')}.md`
  return documentUrl.toString()
}

export const infraAdapter: ContentAdapter<InfraCatalog, InfraPage> = {
  category: 'infra',
  instanceId: 'infra',
  async load(baseUrl) {
    try {
      return infraCatalogSchema.parse(await ofetch(baseUrl, { headers: { Accept: 'application/json' } }))
    }
    catch (cause) {
      throw new ContentDirectoryError({ category: 'infra', cause, message: 'The infra directory returned an unexpected response.' })
    }
  },
  entries: catalog => catalog.data,
  findById: (catalog, id) => catalog.data.find(page => page.id === id),
  format: page => ({ id: page.id, title: page.title, url: page.url, description: page.description, type: page.type, language: page.language }),
  async retrieve(page) {
    try {
      return await ofetch(markdownUrl(page.url), { headers: { Accept: 'text/markdown, text/plain;q=0.9' }, responseType: 'text' })
    }
    catch (cause) {
      throw new ContentRetrievalError({ category: 'infra', cause })
    }
  },
}
