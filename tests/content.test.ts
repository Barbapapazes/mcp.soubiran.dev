import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerContentTools } from '../src/tools/content'
import { categoriesByInstanceId, contentAdapters } from '../src/tools/content/adapters'
import { infraAdapter, infraCatalogSchema } from '../src/tools/content/adapters/infra'
import { pagesAdapter, pagesCatalogSchema, pageSchema } from '../src/tools/content/adapters/pages'
import { talksAdapter, talksCatalogSchema, talkTopics } from '../src/tools/content/adapters/talks'
import { executeContentCode } from '../src/tools/content/code-mode'
import { ContentCodeExecutionError } from '../src/tools/content/errors'
import { listContentDescription } from '../src/tools/content/list'

vi.mock('@sentry/cloudflare', () => ({ captureException: vi.fn() }))

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
  id: 'talk-1',
  type: 'talk' as const,
  title: 'Talk',
  date: '2026-01-01',
  url: 'https://talks.soubiran.dev/talk-1',
  language: 'en',
  topics: ['Workers', 'TypeScript', 'Workers'],
  event: { name: 'Event', url: 'https://event.example', location: { city: 'Lille', country: 'France' } },
  links: { slides: 'https://example.com/slides', source: 'https://example.com/source', pdf: 'https://example.com/talk.pdf', transcript: 'https://example.com/transcript.md' },
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
  schemaVersion: '1.0',
  generatedAt: '2026-01-01T00:00:00.000Z',
  site: { id: 'talks.soubiran.dev', url: 'https://talks.soubiran.dev' },
  data: [talk],
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
    expect(pagesCatalogSchema.parse(pages).data[0]?.type).toBe('post')
    expect(talksCatalogSchema.parse(talks).data[0]?.topics).toEqual(['Workers', 'TypeScript', 'Workers'])
    expect(infraCatalogSchema.parse(infraCatalog).data[0]?.ecosystem?.[0]?.ecosystem?.[0]?.name).toBe('mcp.soubiran.dev')
  })

  it('keeps talk topics open-ended and deterministically derived', () => {
    expect(talkTopics(talks)).toEqual(['TypeScript', 'Workers'])
  })

  it('resolves entries by their stable IDs', async () => {
    expect(pagesAdapter.findById(pages, page.id)).toEqual(page)
    expect(talksAdapter.findById(talks, talk.id)).toEqual(talk)
    expect(infraAdapter.findById(infraCatalog, infra.id)).toEqual(infra)
    await expect(talksAdapter.retrieve({ ...talk, links: { ...talk.links, transcript: undefined } })).rejects.toMatchObject({ message: expect.stringContaining('No transcript') })
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
      'https://talks.soubiran.dev/talk-1/transcript.en.md',
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
    expect(description).toContain('type TalksCatalog = Catalog<Talk>')
    expect(description).toContain('type EcosystemNode')
    expect(description).toContain('Current talk topics: TypeScript, Workers.')
    expect(description).toContain('const allContent')
    expect(description).toContain('const ecosystemNodes')
  })
})

describe('content tool registration', () => {
  function fakeServer() {
    const descriptions: Record<string, string> = {}
    const server = {
      registerTool: (name: string, config: { description: string }) => {
        descriptions[name] = config.description
      },
    } as unknown as McpServer
    return { server, descriptions }
  }

  function contentEnv(talksUrl: string): Env {
    return {
      TALKS_BASE_URL: talksUrl,
      PAGES_BASE_URL: 'https://soubiran.dev/pages.json',
      INFRA_BASE_URL: 'https://infra.soubiran.dev/pages.json',
    } as unknown as Env
  }

  function catalogResponse(status: number, body?: unknown) {
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }

  it('registers tools with empty topics when the talks catalog is unavailable', async () => {
    const { server, descriptions } = fakeServer()
    const talksUrl = 'https://unavailable.test/talks.json'
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      return url === talksUrl ? catalogResponse(404) : catalogResponse(200)
    })

    await expect(registerContentTools(server, contentEnv(talksUrl))).resolves.toBeUndefined()
    expect(descriptions.list_content).toContain('Current talk topics: none.')
    expect(descriptions.get_content).toBeDefined()
    expect(descriptions.search_content).toBeDefined()
  })

  it('retries a failed talks catalog load on the next registration instead of pinning it', async () => {
    const talksUrl = 'https://retry.test/talks.json'
    let talksRequests = 0
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === talksUrl) {
        talksRequests += 1
        return talksRequests === 1 ? catalogResponse(404) : catalogResponse(200, talks)
      }
      return catalogResponse(200)
    })

    const first = fakeServer()
    await registerContentTools(first.server, contentEnv(talksUrl))
    expect(first.descriptions.list_content).toContain('Current talk topics: none.')

    const second = fakeServer()
    await registerContentTools(second.server, contentEnv(talksUrl))
    expect(second.descriptions.list_content).toContain('Current talk topics: TypeScript, Workers.')
    expect(talksRequests).toBe(2)
  })

  it('caches a successful talks catalog load across registrations', async () => {
    const talksUrl = 'https://cached.test/talks.json'
    let talksRequests = 0
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === talksUrl) {
        talksRequests += 1
        return catalogResponse(200, talks)
      }
      return catalogResponse(200)
    })

    const first = fakeServer()
    await registerContentTools(first.server, contentEnv(talksUrl))
    const second = fakeServer()
    await registerContentTools(second.server, contentEnv(talksUrl))
    expect(second.descriptions.list_content).toContain('Current talk topics: TypeScript, Workers.')
    expect(talksRequests).toBe(1)
  })
})
