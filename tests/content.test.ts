import { afterEach, describe, expect, it, vi } from 'vitest'
import { categoriesByInstanceId, contentAdapters } from '../src/tools/content/adapters'
import { infraAdapter, infraCatalogSchema } from '../src/tools/content/adapters/infra'
import { pagesAdapter, pagesCatalogSchema, pageSchema } from '../src/tools/content/adapters/pages'
import { talksAdapter, talksCatalogSchema, talkSchema, talkTopics } from '../src/tools/content/adapters/talks'
import { executeContentCode } from '../src/tools/content/code-mode'
import { ContentCodeExecutionError } from '../src/tools/content/errors'
import { listContentDescription } from '../src/tools/content/list'

const page = {
  id: 'page-1',
  type: 'post' as const,
  title: 'Page',
  description: 'A page',
  language: 'en',
  slug: 'posts/page',
  url: 'https://soubiran.dev/posts/page',
  date: '2026-01-01',
}
const talk = {
  prefix: '2026-01-01/event',
  name: 'Talk',
  description: 'A talk',
  date: '2026-01-01',
  url: 'https://talks.soubiran.dev/2026-01-01/event',
  language: 'en',
  topics: ['Workers', 'TypeScript', 'Workers'],
  event: 'Event',
  event_url: 'https://event.example',
  folder: '2026-01-01',
  location: { city: 'Lille', country: 'France', latitude: 50.63, longitude: 3.06 },
  thumbnail_url: 'https://talks.soubiran.dev/2026-01-01/event/thumbnail.png',
  thumbnail_dark_url: 'https://talks.soubiran.dev/2026-01-01/event/thumbnail-dark.png',
  pdf_url: 'https://talks.soubiran.dev/2026-01-01/event/pdf',
  github_url: 'https://talks.soubiran.dev/2026-01-01/event/src',
  transcript_url: 'https://soubiran.dev/talks/2026-01-01/event',
}
const infra = {
  id: 'infra-1',
  type: 'documentation',
  title: 'Infra',
  language: 'en',
  url: 'https://infra.soubiran.dev/infra',
  ecosystem: [{ type: 'service', name: 'MCP', ecosystem: [{ type: 'domain', name: 'mcp.soubiran.dev' }] }],
}
const pages = {
  schemaVersion: '1.0',
  generatedAt: '2026-01-01T00:00:00.000Z',
  site: { id: 'soubiran.dev', url: 'https://soubiran.dev' },
  data: [page],
}
const talks = {
  data: [talk],
  statistics: { totalTalks: 1 },
}
const infraCatalog = {
  schemaVersion: '1.0',
  generatedAt: '2026-01-01T00:00:00.000Z',
  site: { id: 'infra.soubiran.dev', url: 'https://infra.soubiran.dev' },
  data: [infra],
}

function mockLoader(response: { error?: string, resultJson?: string }) {
  return { get: () => ({ getEntrypoint: () => ({ evaluate: async () => response }) }) } as unknown as WorkerLoader
}

function sourceCapturingMockLoader(response: { error?: string, resultJson?: string }) {
  let source: string | undefined
  const loader = {
    get: (_name: string, factory: () => { modules: Record<string, string> }) => {
      source = factory().modules['worker.js']
      return { getEntrypoint: () => ({ evaluate: async () => response }) }
    },
  } as unknown as WorkerLoader

  return { loader, source: () => source }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('content adapters', () => {
  it('strictly validates source catalogs while preserving recursive infra data', () => {
    expect(pageSchema.parse(page)).toEqual(page)
    expect(pageSchema.safeParse({ ...page, unexpected: true }).success).toBe(false)
    expect(talkSchema.parse(talk)).toEqual(talk)
    expect(talkSchema.safeParse({ ...talk, unexpected: true }).success).toBe(false)
    expect(pagesCatalogSchema.parse(pages).data[0]?.type).toBe('post')
    expect(talksCatalogSchema.parse(talks).data[0]?.topics).toEqual(['Workers', 'TypeScript', 'Workers'])
    expect(infraCatalogSchema.parse(infraCatalog).data[0]?.ecosystem?.[0]?.ecosystem?.[0]?.name).toBe('mcp.soubiran.dev')
  })

  it('keeps talk topics open-ended and deterministically derived', () => {
    expect(talkTopics(talks)).toEqual(['TypeScript', 'Workers'])
  })

  it('keeps the producer statistics block next to the talks entries', () => {
    const parsed = talksCatalogSchema.parse(talks)

    expect(parsed.data).toHaveLength(1)
    expect(parsed.statistics).toEqual({ totalTalks: 1 })
  })

  it('resolves entries by their stable IDs', async () => {
    expect(pagesAdapter.findById(pages, page.id)).toEqual(page)
    expect(talksAdapter.findById(talks, talk.prefix)).toEqual(talk)
    expect(infraAdapter.findById(infraCatalog, infra.id)).toEqual(infra)
    await expect(talksAdapter.retrieve({ ...talk, transcript_url: undefined })).rejects.toMatchObject({ message: expect.stringContaining('No transcript') })
  })

  it('retrieves Markdown documents from their published URLs', async () => {
    const requestedUrls: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      requestedUrls.push(typeof input === 'string' ? input : input.toString())
      return new Response('# Document')
    })

    await expect(pagesAdapter.retrieve(page)).resolves.toBe('# Document')
    await expect(pagesAdapter.retrieve({ ...page, url: 'https://soubiran.dev' })).resolves.toBe('# Document')
    await expect(infraAdapter.retrieve(infra)).resolves.toBe('# Document')
    await expect(infraAdapter.retrieve({ ...infra, url: 'https://infra.soubiran.dev/' })).resolves.toBe('# Document')
    await expect(talksAdapter.retrieve(talk)).resolves.toBe('# Document')

    expect(requestedUrls).toEqual([
      'https://soubiran.dev/posts/page.md',
      'https://soubiran.dev/index.md',
      'https://infra.soubiran.dev/infra.md',
      'https://infra.soubiran.dev/index.md',
      'https://talks.soubiran.dev/2026-01-01/event/transcript.en.md',
    ])
  })

  it('maps each configured search instance to exactly one content category', () => {
    expect(Object.values(contentAdapters).map(adapter => adapter.instanceId)).toEqual(['soubiran-dev', 'talks', 'infra-soubiran-dev'])
    expect(categoriesByInstanceId.get('infra-soubiran-dev')).toBe('infra')
  })
})

describe('content code mode', () => {
  const directories = { pages, talks, infra: infraCatalog }

  it('accepts a serialized result from the dynamic executor', async () => {
    await expect(executeContentCode(mockLoader({ resultJson: '["page-1"]' }), directories, 'async () => pages.data.map(page => page.id)')).resolves.toBe('["page-1"]')
  })

  it('bakes submitted code into the dynamic Worker module without eval', async () => {
    const mock = sourceCapturingMockLoader({ resultJson: '[]' })
    await executeContentCode(mock.loader, directories, 'async () => talks.data // a trailing comment')

    expect(mock.source()).toContain('const submittedFunction = (\nasync () => talks.data // a trailing comment\n)')
    expect(mock.source()).toContain('const result = await submittedFunction()')
    expect(mock.source()).not.toContain('(0, eval)')
  })

  it('rejects non-async-arrow input and submitted code failures', async () => {
    await expect(executeContentCode(mockLoader({ resultJson: '[]' }), directories, '() => pages')).rejects.toBeInstanceOf(ContentCodeExecutionError)
    await expect(executeContentCode(mockLoader({ error: 'Network access is not available.' }), directories, 'async () => fetch()')).rejects.toBeInstanceOf(ContentCodeExecutionError)
  })

  it('documents source shapes, current talk topics, and copy-ready helpers', () => {
    const description = listContentDescription(['TypeScript', 'Workers'])

    expect(description).toContain('type PagesCatalog = Catalog<Page>')
    expect(description).toContain('type TalksCatalog = { data: Talk[], statistics: Record<string, unknown> }')
    expect(description).toContain('prefix: string // stable talk ID, use with get_content')
    expect(description).toContain('type EcosystemNode')
    expect(description).toContain('Current talk topics: TypeScript, Workers.')
    expect(description).toContain('const allContent')
    expect(description).toContain('const ecosystemNodes')
  })
})
