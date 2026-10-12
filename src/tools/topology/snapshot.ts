import { ofetch } from 'ofetch'
import { z } from 'zod'

const evidenceSchema = z.object({ documentId: z.string().min(1), pointer: z.string() })
const relationshipSchema = z.enum(['producer', 'consumer'])

interface EcosystemItem {
  type?: string
  relationship?: 'producer' | 'consumer'
  id?: string
  name: string
  description?: string
  descriptions?: string[]
  href?: string
  ecosystem?: EcosystemItem[]
}

const ecosystemItemSchema: z.ZodType<EcosystemItem> = z.lazy(() => z.object({
  type: z.string().optional(),
  relationship: relationshipSchema.optional(),
  id: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  descriptions: z.array(z.string()).optional(),
  href: z.string().optional(),
  ecosystem: z.array(ecosystemItemSchema).optional(),
}))

export const topologySchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.string().nullable(),
  nodes: z.array(z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    name: z.string().min(1),
    identity: z.enum(['product', 'repository-url', 'shared-technology', 'scoped', 'document']),
    ownerId: z.string().optional(),
    href: z.string().optional(),
    documentId: z.string().optional(),
    description: z.string().optional(),
    repository: z.object({ url: z.url(), private: z.boolean() }).optional(),
    evidence: z.array(evidenceSchema),
  })),
  edges: z.array(z.object({
    id: z.string().min(1),
    source: z.string().min(1),
    target: z.string().min(1),
    parent: z.string().min(1),
    item: z.string().min(1),
    relationship: relationshipSchema,
    relationshipExplicit: z.boolean(),
    descriptions: z.array(z.string()),
    evidence: evidenceSchema,
  })),
  documents: z.array(z.object({
    id: z.string().min(1),
    nodeId: z.string().min(1),
    path: z.string().min(1),
    title: z.string(),
    description: z.string(),
    markdownUrl: z.string().min(1),
    markdown: z.string(),
    ecosystem: z.array(ecosystemItemSchema),
    links: z.array(z.object({
      href: z.string(),
      text: z.string(),
      documentId: z.string().optional(),
      nodeId: z.string().optional(),
    })),
  })),
  diagnostics: z.array(z.object({
    code: z.literal('unresolved-document-link'),
    documentId: z.string().min(1),
    href: z.string(),
  })),
})

export type Topology = z.infer<typeof topologySchema>

export async function loadTopology(env: Env): Promise<Topology> {
  try {
    // Preserve source paths and pointers verbatim: evidence resolves against documents.
    return topologySchema.parse(await ofetch(env.TOPOLOGY_URL, {
      headers: { Accept: 'application/json' },
      timeout: 10_000,
      retry: 0,
    }))
  }
  catch (cause) {
    throw new Error('The topology snapshot is unavailable or has an unsupported schema.', { cause })
  }
}
