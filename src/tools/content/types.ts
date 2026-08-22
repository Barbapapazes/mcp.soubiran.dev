export const contentCategories = ['pages', 'talks', 'infra'] as const

export type ContentCategory = typeof contentCategories[number]

export interface ContentMetadata {
  id: string
  title: string
  url: string
  [key: string]: unknown
}

export interface ContentAdapter<Directory, Entry> {
  category: ContentCategory
  instanceId: string
  load: (baseUrl: string) => Promise<Directory>
  entries: (directory: Directory) => readonly Entry[]
  findById: (directory: Directory, id: string) => Entry | undefined
  format: (entry: Entry) => ContentMetadata
  retrieve: (entry: Entry) => Promise<string>
}

export interface ContentSearchResult {
  score: number
  excerpt: string
  source: string
  category: ContentCategory
  content: ContentMetadata
  metadata?: Record<string, unknown>
}
