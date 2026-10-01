import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeContentCode } from '../src/tools/content/code-mode'
import { ContentCodeExecutionError, ContentCodeExecutorError } from '../src/tools/content/errors'
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
    await expect(loadPagesFeed(env.PAGES_EN_URL)).rejects.toMatchObject({ message: 'The pages feed returned an unexpected response.' })
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
    registerContentTools(server, env)
    expect(registerTool.mock.calls.map(call => call[0])).toEqual(['list_pages', 'get_page', 'search_content'])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns a not-found error for pages not yet published', async () => {
    mockFeeds()
    const { server, registerTool } = mockServer()
    registerGetPageTool(server, env)
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
    registerGetPageTool(server, env)
    expect(await registerTool.mock.calls[0]![2]({ id: page.id })).toEqual({ content: [{ type: 'text', text: '# Full page' }] })
  })

  it.each([registerGetPageTool, registerListPagesTool])('reports feed failures as tool errors', async (register) => {
    mockFeeds([{ ...page, locale: 'invalid' }])
    const { server, registerTool } = mockServer()
    register(server, env)
    expect(await registerTool.mock.calls[0]![2]({ id: page.id, code: 'async () => pages' })).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Unable to retrieve the pages.' }],
    })
  })

  it('returns serialized code results and distinguishes client errors from executor failures', async () => {
    mockFeeds()
    const { server, registerTool } = mockServer()
    const codeEnv = { ...env, CONTENT_LOADER: mockLoader({ resultJson: '["page-1"]' }).loader } as Env
    registerListPagesTool(server, codeEnv)
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
    registerSearchContentTool(server, { ...env, AI_SEARCH: { search } } as unknown as Env)
    const result = await registerTool.mock.calls[0]![2]({ query: 'page' })
    const data = JSON.parse(result.content[0].text)
    expect(data.results).toHaveLength(1)
    expect(data.results[0].content).toMatchObject({ id: page.id, locale: 'en' })
    expect(search.mock.calls[0]?.[0].ai_search_options.instance_ids).toEqual(['soubiran-dev'])
  })

  it('preserves search warnings even when there are no matching pages', async () => {
    mockFeeds()
    const search = vi.fn(async () => ({ chunks: [], errors: [{ instance_id: 'soubiran-dev', message: 'Temporarily unavailable' }] }))
    const { server, registerTool } = mockServer()
    registerSearchContentTool(server, { ...env, AI_SEARCH: { search } } as unknown as Env)
    const result = await registerTool.mock.calls[0]![2]({ query: 'page' })
    expect(JSON.parse(result.content[0].text)).toEqual({ results: [], warnings: ['Search failed for soubiran-dev: Temporarily unavailable'] })
  })

  it('returns a plain message for an empty search without warnings', async () => {
    mockFeeds()
    const { server, registerTool } = mockServer()
    registerSearchContentTool(server, { ...env, AI_SEARCH: { search: async () => ({ chunks: [] }) } } as unknown as Env)
    expect(await registerTool.mock.calls[0]![2]({ query: 'page' })).toEqual({ content: [{ type: 'text', text: 'No matching content was found.' }] })
  })

  it('reports search failures before feed failures', async () => {
    mockFeeds([{ ...page, locale: 'invalid' }])
    const search = vi.fn().mockRejectedValue(new Error('Search unavailable'))
    const { server, registerTool } = mockServer()
    registerSearchContentTool(server, { ...env, AI_SEARCH: { search } } as unknown as Env)
    expect(await registerTool.mock.calls[0]![2]({ query: 'page' })).toMatchObject({ isError: true, content: [{ text: 'Unable to search content: Search unavailable' }] })
  })
})

describe('content code mode', () => {
  it('accepts a serialized result from the dynamic executor', async () => {
    await expect(executeContentCode(mockLoader({ resultJson: '["page-1"]' }).loader, [page], 'async () => pages.map(page => page.id)')).resolves.toBe('["page-1"]')
  })

  it('exposes only the frozen pages array and bakes code into the module without eval', async () => {
    const mock = mockLoader({ resultJson: '[]' })
    await executeContentCode(mock.loader, [page], 'async () => pages // a trailing comment')
    expect(mock.source()).toContain('const submittedFunction = (\nasync () => pages // a trailing comment\n)')
    expect(mock.source()).toContain('const pages = deepFreeze([')
    expect(mock.source()).toContain('const result = await submittedFunction()')
    expect(mock.source()).not.toContain('const talks')
    expect(mock.source()).not.toContain('const infra')
    expect(mock.source()).not.toContain('(0, eval)')
  })

  it('rejects non-async-arrow input and submitted code failures', async () => {
    await expect(executeContentCode(mockLoader({ resultJson: '[]' }).loader, [page], '() => pages')).rejects.toBeInstanceOf(ContentCodeExecutionError)
    await expect(executeContentCode(mockLoader({ error: 'Network access is not available.' }).loader, [page], 'async () => fetch()')).rejects.toBeInstanceOf(ContentCodeExecutionError)
  })

  it.each(['', 'async () =>', 'async function () {}', 'async () => pages; async () => pages'])('rejects invalid or unsupported code: %s', async (code) => {
    await expect(executeContentCode(mockLoader({ resultJson: '[]' }).loader, [page], code)).rejects.toBeInstanceOf(ContentCodeExecutionError)
  })

  it('rejects missing JSON and oversized UTF-8 results', async () => {
    await expect(executeContentCode(mockLoader({}).loader, [page], 'async () => pages')).rejects.toMatchObject({
      message: 'Code must return a JSON-serializable value.',
    })
    await expect(executeContentCode(mockLoader({ resultJson: JSON.stringify('é'.repeat(128 * 1024)) }).loader, [page], 'async () => pages')).rejects.toMatchObject({
      message: expect.stringContaining('256 KiB'),
    })
  })

  it('preserves executor failures and their causes', async () => {
    const cause = new Error('Worker unavailable')
    const loader = { get: () => {
      throw cause
    } } as unknown as WorkerLoader
    await expect(executeContentCode(loader, [page], 'async () => pages')).rejects.toBeInstanceOf(ContentCodeExecutorError)
    await expect(executeContentCode(loader, [page], 'async () => pages')).rejects.toMatchObject({ message: cause.message, cause })
  })

  it('documents the unified page array and both locales', () => {
    const description = listPagesDescription
    expect(description).toContain('const pages: Page[]')
    expect(description).toContain('locale: "en" | "fr"')
    expect(description).toContain('markdownUrl: string')
    expect(description).not.toContain('Catalog')
    expect(description).toContain('latest matching post')
    expect(description).toContain('rather than returning the full catalog')
    expect(description).toContain('get_page')
    expect(description).toContain('search_content')
  })
})
