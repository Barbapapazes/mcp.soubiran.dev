import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { env as runtimeEnv } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeSnapshotCode } from '../src/tools/code-mode'
import { registerGetQuickNewsTool } from '../src/tools/quick-news/get'
import { registerQuickNewsTools } from '../src/tools/quick-news/index'
import { registerListQuickNewsTool } from '../src/tools/quick-news/list'
import { loadNews, newsCategories, retrieveNews } from '../src/tools/quick-news/news'
import { registerSearchQuickNewsTool } from '../src/tools/quick-news/search'

const news = {
  id: 'a'.repeat(32),
  url: 'https://example.com/original',
  title: 'Workers announcement',
  summary: 'An editorial summary',
  category: 'Cloudflare',
  authors: ['Example Author'],
  filename: 'current-version.md',
  released_at: '2026-01-01',
  processed_at: '2026-01-02T12:00:00.000000Z',
  created_at: '2026-01-02T10:00:00.000000Z',
  discord_message_url: null,
}
const env = { QUICK_NEWS_API_URL: 'https://api.soubiran.dev/api/quick-news' } as Env

function mockCatalog(items = [news]) {
  const fetch = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({ data: items })))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function mockServer() {
  const registerTool = vi.fn()
  return { server: { registerTool } as unknown as McpServer, registerTool }
}

function chunk(key: string, score = 0.9, text = 'Excerpt', instance_id = 'quick-news-soubiran-dev') {
  return { instance_id, score, text, item: { key, metadata: { id: news.id, category: 'Misleading index category' } } }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('published Quick News data', () => {
  it('loads the full catalog and derives consistent category counts without private configuration', async () => {
    const fetch = mockCatalog([
      news,
      { ...news, id: 'b'.repeat(32), filename: 'second.md' },
      { ...news, id: 'c'.repeat(32), filename: 'third.md', category: 'AI' },
    ])
    const items = await loadNews(env)
    expect(items).toHaveLength(3)
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.soubiran.dev/api/quick-news/catalog')
    expect(newsCategories(items)).toEqual([
      { name: 'AI', published_count: 1 },
      { name: 'Cloudflare', published_count: 2 },
    ])
    expect(newsCategories([{ ...news, category: null }])).toEqual([])
  })

  it('rejects duplicate IDs and invalid publication metadata without assuming filenames are unique', async () => {
    mockCatalog([news, { ...news, filename: 'other.md' }])
    await expect(loadNews(env)).rejects.toThrow('duplicate IDs')
    mockCatalog([news, { ...news, id: 'b'.repeat(32) }])
    await expect(loadNews(env)).resolves.toHaveLength(2)
    mockCatalog([{ ...news, filename: '../private.md' }])
    await expect(loadNews(env)).rejects.toMatchObject({ kind: 'schema' })
    mockCatalog([{ ...news, processed_at: null } as unknown as typeof news])
    await expect(loadNews(env)).rejects.toMatchObject({ kind: 'schema' })
  })

  it('registers only three read-only tools without fetching data', () => {
    const fetch = mockCatalog()
    const { server, registerTool } = mockServer()
    registerQuickNewsTools(server, env)
    expect(registerTool.mock.calls.map(call => call[0])).toEqual(['list_quick_news', 'get_quick_news', 'search_quick_news'])
    for (const [, config] of registerTool.mock.calls)
      expect(config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('Quick News code mode', () => {
  it('exposes frozen news and categories through the existing isolated executor', async () => {
    const snapshot = { news: [news], categories: [{ name: 'Cloudflare', published_count: 1 }] }
    await expect(executeSnapshotCode(runtimeEnv.CONTENT_LOADER, snapshot, `async () => ({
      count: news.filter(item => item.category === categories[0].name).length,
      frozen: Object.isFrozen(news) && Object.isFrozen(news[0].authors) && Object.isFrozen(categories[0]),
      network: typeof fetch,
    })`, 'quickNews')).resolves.toBe('{"count":1,"frozen":true,"network":"function"}')
    await expect(executeSnapshotCode(runtimeEnv.CONTENT_LOADER, snapshot, 'async () => fetch("https://example.com")', 'quickNews'))
      .rejects.toThrow('Network access is not available in code mode.')
    await expect(executeSnapshotCode(runtimeEnv.CONTENT_LOADER, snapshot, 'async () => news.push({})', 'quickNews'))
      .rejects.toThrow('Code execution failed')
  })

  it('runs a category query via the list tool with the full catalog', async () => {
    mockCatalog()
    const { server, registerTool } = mockServer()
    registerListQuickNewsTool(server, { ...env, CONTENT_LOADER: runtimeEnv.CONTENT_LOADER } as Env)
    expect(await registerTool.mock.calls[0]![2]({ code: 'async () => news.filter(item => item.category === categories[0].name).length' }))
      .toEqual({ content: [{ type: 'text', text: '1' }] })
    expect(await registerTool.mock.calls[0]![2]({ code: '() => news' }))
      .toMatchObject({ isError: true, content: [{ text: 'Code must be a single async JavaScript arrow function.' }] })
  })

  it('reports catalog and executor failures as tool errors', async () => {
    const fetch = mockCatalog()
    fetch.mockRejectedValue(new Error('Offline'))
    const { server, registerTool } = mockServer()
    const toolEnv = { ...env, CONTENT_LOADER: { get: () => { throw new Error('Unavailable') } } } as unknown as Env
    registerListQuickNewsTool(server, toolEnv)
    const run = registerTool.mock.calls[0]![2]
    expect(await run({ code: 'async () => news.length' })).toMatchObject({ isError: true, content: [{ text: 'Unable to retrieve the published Quick News catalog.' }] })
    mockCatalog()
    expect(await run({ code: 'async () => news.length' })).toMatchObject({ isError: true, content: [{ text: 'Unable to execute code against the Quick News catalog.' }] })
  })
})

describe('Quick News reading', () => {
  it('returns full editorial Markdown with source and summary citations', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({ data: { ...news, markdown: '# Full editorial summary' } })))
    vi.stubGlobal('fetch', fetch)
    const { server, registerTool } = mockServer()
    registerGetQuickNewsTool(server, env)
    const result = await registerTool.mock.calls[0]![2]({ id: news.id })
    expect(JSON.parse(result.content[0].text)).toEqual({
      ...news,
      markdown: '# Full editorial summary',
      content_url: `${env.QUICK_NEWS_API_URL}/${news.id}/content`,
    })
    expect(fetch.mock.calls[0]?.[0]).toBe(`${env.QUICK_NEWS_API_URL}/${news.id}/content`)
  })

  it('rejects content returned for a different ID', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { ...news, id: 'b'.repeat(32), markdown: '# Wrong item' } }))))
    await expect(retrieveNews(env, news.id)).rejects.toThrow('different ID')
  })

  it.each([404, 503])('returns an actionable tool error for HTTP %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Unavailable', { status })))
    const { server, registerTool } = mockServer()
    registerGetQuickNewsTool(server, env)
    expect(await registerTool.mock.calls[0]![2]({ id: news.id })).toMatchObject({
      isError: true,
      content: [{ text: status === 404
        ? 'Published Quick News not found. Use list_quick_news or search_quick_news to find an exact ID.'
        : 'Unable to retrieve the published Quick News content.' }],
    })
  })

  it('rejects filenames, URLs, and path traversal as IDs', () => {
    const { server, registerTool } = mockServer()
    registerGetQuickNewsTool(server, env)
    const schema = registerTool.mock.calls[0]![1].inputSchema.id
    for (const id of ['../private', 'https://example.com', 'file.md', ''])
      expect(schema.safeParse(id).success).toBe(false)
  })
})

describe('Quick News search', () => {
  it('searches the dedicated index, excludes stale and unpublished keys, deduplicates, and checks current categories', async () => {
    const other = { ...news, id: 'b'.repeat(32), filename: 'ai.md', category: 'AI' }
    mockCatalog([news, other])
    const search = vi.fn(async (_input: unknown) => ({ chunks: [
      chunk('unpublished.md', 1),
      chunk('old-version.md', 1),
      chunk(news.filename, 1, 'Wrong index', 'soubiran-dev'),
      chunk(other.filename, 0.99),
      chunk(news.filename, 0.7, 'Lower-ranked duplicate'),
      chunk(news.filename, 0.9, 'Best excerpt'),
    ] }))
    const { server, registerTool } = mockServer()
    registerSearchQuickNewsTool(server, { ...env, QUICK_NEWS_AI_SEARCH: { search } } as unknown as Env)
    const result = await registerTool.mock.calls[0]![2]({ query: 'Workers', category: 'Cloudflare', limit: 1 })
    expect(JSON.parse(result.content[0].text)).toEqual({ results: [{
      score: 0.9,
      excerpt: 'Best excerpt',
      content: {
        id: news.id, title: news.title, url: news.url, category: news.category,
        released_at: news.released_at, processed_at: news.processed_at,
        content_url: `${env.QUICK_NEWS_API_URL}/${news.id}/content`,
      },
    }] })
    expect(search).toHaveBeenCalledWith({ query: 'Workers', ai_search_options: {
      instance_ids: ['quick-news-soubiran-dev'],
      retrieval: { max_num_results: 50, match_threshold: 0.6, return_on_failure: false },
      reranking: { enabled: true, model: '@cf/baai/bge-reranker-base' },
    } })
  })

  it('bounds Unicode excerpts and applies the default eight-item limit', async () => {
    const items = Array.from({ length: 10 }, (_, index) => ({ ...news, id: `id-${index}`, filename: `file-${index}.md` }))
    mockCatalog(items)
    const search = vi.fn(async () => ({ chunks: items.map(item => chunk(item.filename, 0.9, '😀'.repeat(1201))) }))
    const { server, registerTool } = mockServer()
    registerSearchQuickNewsTool(server, { ...env, QUICK_NEWS_AI_SEARCH: { search } } as unknown as Env)
    const result = await registerTool.mock.calls[0]![2]({ query: 'Workers' })
    const data = JSON.parse(result.content[0].text)
    expect(data.results).toHaveLength(8)
    expect(data.results[0].excerpt).toBe(`${'😀'.repeat(1199)}…`)
  })

  it('preserves partial failures and does not claim exhaustive absence', async () => {
    mockCatalog()
    const search = vi.fn(async () => ({ chunks: [], errors: [{ instance_id: 'quick-news-soubiran-dev', message: 'Unavailable' }] }))
    const { server, registerTool } = mockServer()
    registerSearchQuickNewsTool(server, { ...env, QUICK_NEWS_AI_SEARCH: { search } } as unknown as Env)
    const result = await registerTool.mock.calls[0]![2]({ query: 'Workers' })
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      results: [],
      warnings: ['Search failed for quick-news-soubiran-dev: Unavailable'],
      message: expect.stringContaining('does not establish'),
    })
  })

  it('reports search and catalog failures without returning unvalidated excerpts', async () => {
    const fetch = mockCatalog()
    const search = vi.fn().mockRejectedValue(new Error('Search offline'))
    const { server, registerTool } = mockServer()
    registerSearchQuickNewsTool(server, { ...env, QUICK_NEWS_AI_SEARCH: { search } } as unknown as Env)
    const run = registerTool.mock.calls[0]![2]
    expect(await run({ query: 'Workers' })).toMatchObject({ isError: true, content: [{ text: 'Unable to search Quick News.' }] })
    search.mockResolvedValue({ chunks: [chunk(news.filename)] })
    fetch.mockRejectedValue(new Error('Catalog offline'))
    expect(await run({ query: 'Workers' })).toMatchObject({ isError: true, content: [{ text: 'Unable to retrieve the published Quick News catalog to resolve search results.' }] })
  })

  it('validates bounded search inputs and allows query-only calls', () => {
    const { server, registerTool } = mockServer()
    registerSearchQuickNewsTool(server, env)
    const schema = registerTool.mock.calls[0]![1].inputSchema
    expect(schema.query.parse('  Cloudflare  ')).toBe('Cloudflare')
    expect(schema.category.parse(undefined)).toBeUndefined()
    expect(schema.limit.parse(undefined)).toBeUndefined()
    expect(schema.category.safeParse(' ').success).toBe(false)
    for (const query of ['', ' ', 'a'.repeat(1001)])
      expect(schema.query.safeParse(query).success).toBe(false)
    for (const limit of [0, 9, 1.5, '3'])
      expect(schema.limit.safeParse(limit).success).toBe(false)
  })
})
