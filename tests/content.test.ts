import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { env as runtimeEnv } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeExecutionError, CodeExecutorError } from '../src/tools/code-errors'
import { executeSnapshotCode } from '../src/tools/code-mode'
import { registerGetPageTool } from '../src/tools/content/get'
import { registerContentTools } from '../src/tools/content/index'
import { listPagesDescription, registerListPagesTool } from '../src/tools/content/list'
import { loadPages, loadPagesFeed, retrievePage } from '../src/tools/content/pages'
import { registerSearchContentTool } from '../src/tools/content/search'

const page = {
  id: 'posts/page.md',
  type: 'post',
  title: 'Page',
  description: 'A page',
  locale: 'en',
  url: '/posts/page',
  markdownUrl: '/raw/posts/page.md',
  translations: { fr: '/fr/posts/page' },
  date: '2026-01-01',
}
const frenchPage = { ...page, id: 'posts/fr/page.md', locale: 'fr', url: '/fr/posts/page', markdownUrl: '/raw/posts/fr/page.md', translations: { en: '/posts/page' } }
const env = {
  PAGES_EN_URL: 'https://beta.soubiran.dev/pages.en.json',
  PAGES_FR_URL: 'https://beta.soubiran.dev/pages.fr.json',
} as Env

function mockFeeds(en = [page], fr = [frenchPage]) {
  const fetch = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(input.toString().endsWith('pages.fr.json') ? fr : en), { headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function mockLoader(response: { error?: string, resultJson?: string }) {
  let source: string | undefined
  const loader = {
    get: (_name: string, factory: () => { modules: Record<string, string> }) => {
      source = factory().modules['worker.js']
      return { getEntrypoint: () => ({ evaluate: async () => response }) }
    },
  } as unknown as WorkerLoader
  return { loader, source: () => source }
}

function mockServer() {
  const registerTool = vi.fn()
  return { server: { registerTool } as unknown as McpServer, registerTool }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('unified pages', () => {
  it('loads both flat feeds and resolves published, Markdown, and translation URLs', async () => {
    const fetch = mockFeeds()
    const pages = await loadPages(env)
    expect(pages.map(page => page.id)).toEqual([page.id, frenchPage.id])
    expect(pages[0]).toMatchObject({
      locale: 'en',
      url: 'https://beta.soubiran.dev/posts/page',
      markdownUrl: 'https://beta.soubiran.dev/raw/posts/page.md',
      translations: { fr: 'https://beta.soubiran.dev/fr/posts/page' },
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('accepts new page types and absolute URLs without guessing missing content', async () => {
    mockFeeds([{ ...page, type: 'documentation', url: 'https://example.com/page', markdownUrl: 'https://example.com/document.md' }], [])
    expect(await loadPages(env)).toMatchObject([{ type: 'documentation', url: 'https://example.com/page', markdownUrl: 'https://example.com/document.md' }])
  })

  it('rejects invalid feeds and duplicate IDs', async () => {
    mockFeeds([{ ...page, locale: 'invalid' }])
    await expect(loadPagesFeed(env.PAGES_EN_URL)).rejects.toMatchObject({ kind: 'schema', message: expect.stringContaining('does not match the expected schema') })
    mockFeeds([page], [{ ...frenchPage, id: page.id }])
    await expect(loadPages(env)).rejects.toMatchObject({ message: expect.stringContaining('appears in multiple pages') })
  })

  it('retrieves exactly the published Markdown URL', async () => {
    mockFeeds()
    const pages = await loadPages(env)
    const fetch = vi.fn(async (_input: string | URL | Request) => new Response('# Document'))
    vi.stubGlobal('fetch', fetch)
    await expect(retrievePage(pages[1]!)).resolves.toBe('# Document')
    expect(fetch.mock.calls[0]?.[0]).toBe('https://beta.soubiran.dev/raw/posts/fr/page.md')
  })

  it('registers tools without fetching any catalogs', () => {
    const fetch = mockFeeds()
    const { server, registerTool } = mockServer()
    registerContentTools(server, env, { kind: 'service', scopes: ['mcp:content:read'] })
    expect(registerTool.mock.calls.map(call => call[0])).toEqual(['list_pages', 'get_page', 'search_content'])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('registers explicit safety annotations for all tools', () => {
    const { server, registerTool } = mockServer()
    registerContentTools(server, env, { kind: 'service', scopes: ['mcp:content:read'] })
    expect(registerTool.mock.calls).toHaveLength(3)
    for (const [, config] of registerTool.mock.calls) {
      expect(config.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      })
    }
  })

  it('returns a not-found error for pages not yet published', async () => {
    mockFeeds()
    const { server, registerTool } = mockServer()
    registerGetPageTool(server, env, { kind: 'service', scopes: ['mcp:content:read'] })
    const result = await registerTool.mock.calls[0]![2]({ id: 'missing' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('No content matches')
    expect(result.content[0].text).toContain('Use search_content or list_pages to find an exact ID.')
  })

  it('returns the full Markdown for an exact page ID', async () => {
    const fetch = mockFeeds()
    fetch.mockImplementation(async (input) => {
      if (input.toString().endsWith('.md'))
        return new Response('# Full page')
      return new Response(JSON.stringify(input.toString().endsWith('pages.fr.json') ? [frenchPage] : [page]), { headers: { 'Content-Type': 'application/json' } })
    })
    const { server, registerTool } = mockServer()
    registerGetPageTool(server, env, { kind: 'service', scopes: ['mcp:content:read'] })
    expect(await registerTool.mock.calls[0]![2]({ id: page.id })).toEqual({ content: [{ type: 'text', text: '# Full page' }] })
  })

  it.each([registerGetPageTool, registerListPagesTool])('reports feed failures as tool errors', async (register) => {
    mockFeeds([{ ...page, locale: 'invalid' }])
    const { server, registerTool } = mockServer()
    register(server, env, { kind: 'service', scopes: ['mcp:content:read'] })
    expect(await registerTool.mock.calls[0]![2]({ id: page.id, code: 'async () => pages' })).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Unable to retrieve the pages.' }],
    })
  })

  it('returns serialized code results and distinguishes client errors from executor failures', async () => {
    mockFeeds()
    const { server, registerTool } = mockServer()
    const codeEnv = { ...env, CONTENT_LOADER: mockLoader({ resultJson: '["page-1"]' }).loader } as Env
    registerListPagesTool(server, codeEnv, { kind: 'service', scopes: ['mcp:content:read'] })
    const run = registerTool.mock.calls[0]![2]
    expect(await run({ code: 'async () => pages' })).toEqual({ content: [{ type: 'text', text: '["page-1"]' }] })
    expect(await run({ code: '() => pages' })).toMatchObject({ isError: true, content: [{ text: 'Code must be a single async JavaScript arrow function.' }] })
    codeEnv.CONTENT_LOADER = { get: () => {
      throw new Error('Worker unavailable')
    } } as unknown as WorkerLoader
    expect(await run({ code: 'async () => pages' })).toMatchObject({ isError: true, content: [{ text: 'Unable to execute code against the pages: Worker unavailable' }] })
  })

  it('searches only the unified index and enriches known page IDs', async () => {
    mockFeeds()
    const search = vi.fn(async (_input: { ai_search_options: { instance_ids: string[] } }) => ({ chunks: [
      { instance_id: 'soubiran-dev', score: 0.9, text: 'Excerpt', item: { key: '/posts/page', metadata: { id: page.id } } },
      { instance_id: 'soubiran-dev', score: 0.8, text: 'Missing', item: { key: '/missing', metadata: { id: 'missing' } } },
    ] }))
    const { server, registerTool } = mockServer()
    registerSearchContentTool(server, { ...env, AI_SEARCH: { search } } as unknown as Env, { kind: 'service', scopes: ['mcp:content:read'] })
    const result = await registerTool.mock.calls[0]![2]({ query: 'page' })
    const data = JSON.parse(result.content[0].text)
    expect(data.results).toHaveLength(1)
    expect(data.results[0].content).toMatchObject({ id: page.id, locale: 'en' })
    expect(search.mock.calls[0]?.[0].ai_search_options).toMatchObject({
      instance_ids: ['soubiran-dev'],
      retrieval: { max_num_results: 20, return_on_failure: false },
    })
  })

  it('returns only citation metadata and compact JSON', async () => {
    mockFeeds()
    const search = vi.fn(async () => ({ chunks: [
      { instance_id: 'soubiran-dev', score: 0.9, text: 'Excerpt', item: { key: '/posts/page', metadata: { id: page.id, sha256: 'hash', chunk_modality: 'text' } } },
    ] }))
    const { server, registerTool } = mockServer()
    registerSearchContentTool(server, { ...env, AI_SEARCH: { search } } as unknown as Env, { kind: 'service', scopes: ['mcp:content:read'] })
    const result = await registerTool.mock.calls[0]![2]({ query: 'page' })
    const data = JSON.parse(result.content[0].text)
    expect(data).toEqual({ results: [{
      score: 0.9,
      excerpt: 'Excerpt',
      content: {
        id: page.id,
        locale: 'en',
        type: 'post',
        title: 'Page',
        url: 'https://beta.soubiran.dev/posts/page',
        date: '2026-01-01',
      },
    }] })
    expect(result.content[0].text).toBe(JSON.stringify(data))
  })

  it('keeps the highest-ranked excerpt per page and preserves both locales', async () => {
    mockFeeds()
    const search = vi.fn(async () => ({ chunks: [
      { instance_id: 'soubiran-dev', score: 0.7, text: 'Lower-ranked duplicate', item: { metadata: { id: page.id } } },
      { instance_id: 'other-index', score: 1, text: 'Wrong index', item: { metadata: { id: page.id } } },
      { instance_id: 'soubiran-dev', score: 0.8, text: 'French excerpt', item: { metadata: { id: frenchPage.id } } },
      { instance_id: 'soubiran-dev', score: 0.9, text: 'Best English excerpt', item: { metadata: { id: page.id } } },
    ] }))
    const { server, registerTool } = mockServer()
    registerSearchContentTool(server, { ...env, AI_SEARCH: { search } } as unknown as Env, { kind: 'service', scopes: ['mcp:content:read'] })
    const result = await registerTool.mock.calls[0]![2]({ query: 'page' })
    const data = JSON.parse(result.content[0].text)
    expect(data.results.map((result: { excerpt: string }) => result.excerpt)).toEqual(['Best English excerpt', 'French excerpt'])
    expect(data.results.map((result: { content: { locale: string } }) => result.content.locale)).toEqual(['en', 'fr'])
  })

  it('limits results to eight known unique pages rather than eight chunks', async () => {
    const pages = Array.from({ length: 10 }, (_, index) => ({ ...page, id: `page-${index}` }))
    mockFeeds(pages, [])
    const search = vi.fn(async () => ({ chunks: [
      { instance_id: 'soubiran-dev', score: 1, text: 'Unknown page', item: { metadata: { id: 'missing' } } },
      { instance_id: 'soubiran-dev', score: 1, text: 'Missing ID', item: { metadata: {} } },
      ...pages.flatMap((page, index) => [
        { instance_id: 'soubiran-dev', score: 0.9 - index / 100, text: 'Best excerpt', item: { metadata: { id: page.id } } },
        { instance_id: 'soubiran-dev', score: 0.8 - index / 100, text: 'Duplicate', item: { metadata: { id: page.id } } },
      ]),
    ] }))
    const { server, registerTool } = mockServer()
    registerSearchContentTool(server, { ...env, AI_SEARCH: { search } } as unknown as Env, { kind: 'service', scopes: ['mcp:content:read'] })
    const result = await registerTool.mock.calls[0]![2]({ query: 'page' })
    const data = JSON.parse(result.content[0].text)
    expect(data.results.map((result: { content: { id: string } }) => result.content.id)).toEqual(pages.slice(0, 8).map(page => page.id))
  })

  it('filters using published locale and page type before applying the unique-page limit', async () => {
    const secondPost = { ...page, id: 'second-post', title: 'Second post' }
    const talk = { ...page, id: 'talk', type: 'talk' }
    mockFeeds([page, secondPost, talk])
    const search = vi.fn(async () => ({ chunks: [
      { instance_id: 'soubiran-dev', score: 1, text: 'French', item: { metadata: { id: frenchPage.id, locale: 'en', type: 'post' } } },
      { instance_id: 'soubiran-dev', score: 0.95, text: 'Talk', item: { metadata: { id: talk.id, type: 'post' } } },
      { instance_id: 'soubiran-dev', score: 0.9, text: 'First', item: { metadata: { id: page.id, type: 'section' } } },
      { instance_id: 'soubiran-dev', score: 0.85, text: 'Duplicate', item: { metadata: { id: page.id } } },
      { instance_id: 'soubiran-dev', score: 0.8, text: 'Second', item: { metadata: { id: secondPost.id } } },
    ] }))
    const { server, registerTool } = mockServer()
    registerSearchContentTool(server, { ...env, AI_SEARCH: { search } } as unknown as Env, { kind: 'service', scopes: ['mcp:content:read'] })
    const run = registerTool.mock.calls[0]![2]
    const result = await run({ query: 'Cloudflare', locale: 'en', type: 'post', limit: 2 })
    expect(JSON.parse(result.content[0].text).results.map((result: { content: { id: string } }) => result.content.id)).toEqual([page.id, secondPost.id])
    const limited = await run({ query: 'Cloudflare', locale: 'en', type: 'post', limit: 1 })
    expect(JSON.parse(limited.content[0].text).results).toHaveLength(1)
    const french = await run({ query: 'Cloudflare', locale: 'fr' })
    expect(JSON.parse(french.content[0].text).results.map((result: { content: { id: string } }) => result.content.id)).toEqual([frenchPage.id])
    const talks = await run({ query: 'Cloudflare', type: 'talk' })
    expect(JSON.parse(talks.content[0].text).results.map((result: { content: { id: string } }) => result.content.id)).toEqual([talk.id])
    const empty = await run({ query: 'Cloudflare', type: 'series' })
    expect(empty.content[0].text).toContain('does not establish')
  })

  it('validates search inputs and keeps existing query-only calls valid', () => {
    const { server, registerTool } = mockServer()
    registerSearchContentTool(server, env, { kind: 'service', scopes: ['mcp:content:read'] })
    const { inputSchema, description } = registerTool.mock.calls[0]![1]
    expect(inputSchema.query.parse('  Cloudflare  ')).toBe('Cloudflare')
    expect(inputSchema.locale.parse(undefined)).toBeUndefined()
    expect(inputSchema.type.parse(undefined)).toBeUndefined()
    expect(inputSchema.limit.parse(undefined)).toBeUndefined()
    for (const query of ['', ' ', 'a'.repeat(1001)])
      expect(inputSchema.query.safeParse(query).success).toBe(false)
    for (const locale of ['de', 'EN'])
      expect(inputSchema.locale.safeParse(locale).success).toBe(false)
    for (const limit of [0, 9, 1.5, '3'])
      expect(inputSchema.limit.safeParse(limit).success).toBe(false)
    expect(inputSchema.type.parse('documentation')).toBe('documentation')
    expect(inputSchema.type.safeParse(' ').success).toBe(false)
    expect(description).toContain('results are not exhaustive')
  })

  it('keeps an eight-page response below 45 KiB even with long Unicode excerpts', async () => {
    const pages = Array.from({ length: 8 }, (_, index) => ({ ...page, id: `page-${index}` }))
    mockFeeds(pages, [])
    const search = vi.fn(async () => ({ chunks: pages.flatMap(page => [
      { instance_id: 'soubiran-dev', score: 0.9, text: '😀'.repeat(10000), item: { metadata: { id: page.id } } },
      { instance_id: 'soubiran-dev', score: 0.8, text: 'Duplicate', item: { metadata: { id: page.id } } },
    ]) }))
    const { server, registerTool } = mockServer()
    registerSearchContentTool(server, { ...env, AI_SEARCH: { search } } as unknown as Env, { kind: 'service', scopes: ['mcp:content:read'] })
    const result = await registerTool.mock.calls[0]![2]({ query: 'Cloudflare' })
    expect(JSON.parse(result.content[0].text).results).toHaveLength(8)
    expect(new TextEncoder().encode(result.content[0].text).byteLength).toBeLessThan(45 * 1024)
  })

  it.each([
    ['  Short excerpt  ', 'Short excerpt'],
    ['a'.repeat(1200), 'a'.repeat(1200)],
    ['a'.repeat(1201), `${'a'.repeat(1199)}…`],
    ['😀'.repeat(1201), `${'😀'.repeat(1199)}…`],
  ])('bounds excerpts without splitting Unicode characters', async (text, expected) => {
    mockFeeds()
    const search = vi.fn(async () => ({ chunks: [
      { instance_id: 'soubiran-dev', score: 0.9, text, item: { metadata: { id: page.id } } },
    ] }))
    const { server, registerTool } = mockServer()
    registerSearchContentTool(server, { ...env, AI_SEARCH: { search } } as unknown as Env, { kind: 'service', scopes: ['mcp:content:read'] })
    const result = await registerTool.mock.calls[0]![2]({ query: 'page' })
    expect(JSON.parse(result.content[0].text).results[0].excerpt).toBe(expected)
  })

  it('preserves search warnings even when there are no matching pages', async () => {
    mockFeeds()
    const search = vi.fn(async () => ({ chunks: [], errors: [{ instance_id: 'soubiran-dev', message: 'Temporarily unavailable' }] }))
    const { server, registerTool } = mockServer()
    registerSearchContentTool(server, { ...env, AI_SEARCH: { search } } as unknown as Env, { kind: 'service', scopes: ['mcp:content:read'] })
    const result = await registerTool.mock.calls[0]![2]({ query: 'page' })
    expect(JSON.parse(result.content[0].text)).toEqual({ results: [], warnings: ['Search failed for soubiran-dev: Temporarily unavailable'] })
  })

  it('does not assert corpus-wide absence for an empty search without warnings', async () => {
    mockFeeds()
    const { server, registerTool } = mockServer()
    registerSearchContentTool(server, { ...env, AI_SEARCH: { search: async () => ({ chunks: [] }) } } as unknown as Env, { kind: 'service', scopes: ['mcp:content:read'] })
    expect(await registerTool.mock.calls[0]![2]({ query: 'page' })).toEqual({ content: [{ type: 'text', text: 'No matching pages were returned for this query and filters. This does not establish that no such content exists on the site.' }] })
  })

  it('reports search failures before feed failures', async () => {
    mockFeeds([{ ...page, locale: 'invalid' }])
    const search = vi.fn().mockRejectedValue(new Error('Search unavailable'))
    const { server, registerTool } = mockServer()
    registerSearchContentTool(server, { ...env, AI_SEARCH: { search } } as unknown as Env, { kind: 'service', scopes: ['mcp:content:read'] })
    expect(await registerTool.mock.calls[0]![2]({ query: 'page' })).toMatchObject({ isError: true, content: [{ text: 'Unable to search content: Search unavailable' }] })
  })
})

describe('content code mode', () => {
  it('executes a page query with the real Worker Loader binding', async () => {
    await expect(executeSnapshotCode(runtimeEnv.CONTENT_LOADER, [page], 'async () => pages.map(page => page.id)', 'pages')).resolves.toBe(JSON.stringify([page.id]))
  })

  it('accepts a serialized result from the dynamic executor', async () => {
    await expect(executeSnapshotCode(mockLoader({ resultJson: '["page-1"]' }).loader, [page], 'async () => pages.map(page => page.id)', 'pages')).resolves.toBe('["page-1"]')
  })

  it('exposes only the frozen pages array and bakes code into the module without eval', async () => {
    const mock = mockLoader({ resultJson: '[]' })
    await executeSnapshotCode(mock.loader, [page], 'async () => pages // a trailing comment', 'pages')
    expect(mock.source()).toContain('const submittedFunction = (\nasync () => pages // a trailing comment\n)')
    expect(mock.source()).toContain('const pages = deepFreeze([')
    expect(mock.source()).toContain('const result = await submittedFunction()')
    expect(mock.source()).not.toContain('const talks')
    expect(mock.source()).not.toContain('const infra')
    expect(mock.source()).not.toContain('(0, eval)')
  })

  it('rejects non-async-arrow input and submitted code failures', async () => {
    await expect(executeSnapshotCode(mockLoader({ resultJson: '[]' }).loader, [page], '() => pages', 'pages')).rejects.toBeInstanceOf(CodeExecutionError)
    await expect(executeSnapshotCode(mockLoader({ error: 'Network access is not available.' }).loader, [page], 'async () => fetch()', 'pages')).rejects.toBeInstanceOf(CodeExecutionError)
  })

  it.each(['', 'async () =>', 'async function () {}', 'async () => pages; async () => pages'])('rejects invalid or unsupported code: %s', async (code) => {
    await expect(executeSnapshotCode(mockLoader({ resultJson: '[]' }).loader, [page], code, 'pages')).rejects.toBeInstanceOf(CodeExecutionError)
  })

  it('rejects missing JSON and oversized UTF-8 results', async () => {
    await expect(executeSnapshotCode(mockLoader({}).loader, [page], 'async () => pages', 'pages')).rejects.toMatchObject({
      message: 'Code must return a JSON-serializable value.',
    })
    await expect(executeSnapshotCode(mockLoader({ resultJson: JSON.stringify('é'.repeat(128 * 1024)) }).loader, [page], 'async () => pages', 'pages')).rejects.toMatchObject({
      message: expect.stringContaining('256 KiB'),
    })
  })

  it('preserves executor failures and their causes', async () => {
    const cause = new Error('Worker unavailable')
    const loader = { get: () => {
      throw cause
    } } as unknown as WorkerLoader
    await expect(executeSnapshotCode(loader, [page], 'async () => pages', 'pages')).rejects.toBeInstanceOf(CodeExecutorError)
    await expect(executeSnapshotCode(loader, [page], 'async () => pages', 'pages')).rejects.toMatchObject({ message: cause.message, cause })
  })

  it('documents the unified page array and both locales', () => {
    const description = listPagesDescription
    expect(description).toContain('const pages: Page[]')
    expect(description).toContain('locale: "en" | "fr"')
    expect(description).toContain('markdownUrl: string')
    expect(description).not.toContain('Catalog')
    expect(description).toContain('latest matching post')
    expect(description).toContain('rather than returning the full catalog')
    expect(description).toContain('page.type === \'talk\').length')
    expect(description).toContain('return a number with .length')
    expect(description).toContain('get_page')
    expect(description).toContain('search_content')
  })
})
