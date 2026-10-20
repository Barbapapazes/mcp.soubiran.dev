import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { loadPages, loadPagesFeed, retrievePage } from '../src/tools/content/pages'
import { loadRemoteJson, loadRemoteText, REMOTE_DOCUMENT_TIMEOUT_MS } from '../src/tools/remote-document'
import { loadTopology } from '../src/tools/topology/snapshot'

const feedUrl = 'https://example.com/pages.en.json'
const schema = z.object({ data: z.array(z.string()) })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('remote document diagnostics', () => {
  it.each([404, 503])('reports HTTP %i without silently retrying', async (status) => {
    const fetch = vi.fn(async () => new Response('Unavailable', { status }))
    vi.stubGlobal('fetch', fetch)
    await expect(loadPagesFeed(feedUrl)).rejects.toMatchObject({
      name: 'RemoteDocumentError',
      kind: 'http',
      status,
      url: feedUrl,
      message: `The pages feed request to ${feedUrl} failed with HTTP ${status}.`,
      cause: expect.any(Error),
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('separates malformed JSON, schema drift, and connection failures', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>Not JSON</html>'))
    await expect(loadRemoteJson(feedUrl, 'pages feed', schema)).rejects.toMatchObject({ kind: 'json', cause: expect.any(SyntaxError) })

    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [123] })))
    await expect(loadRemoteJson(feedUrl, 'pages feed', schema)).rejects.toMatchObject({ kind: 'schema', cause: expect.any(z.ZodError) })

    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Connection failed')
    })
    await expect(loadRemoteJson(feedUrl, 'pages feed', schema)).rejects.toMatchObject({ kind: 'network', cause: expect.any(Error) })
  })

  it('omits URL credentials and tokens from the diagnostic message and URL field', async () => {
    vi.stubGlobal('fetch', async () => new Response('Not found', { status: 404 }))
    const error = await loadPagesFeed('https://user:password@example.com/feed?token=secret#private').catch(error => error)
    expect(error.url).toBe('https://example.com/feed')
    expect(error.message).toBe('The pages feed request to https://example.com/feed failed with HTTP 404.')
  })

  it('keeps a plain JSON string distinct from a valid object payload', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify('not a catalog')))
    await expect(loadRemoteJson(feedUrl, 'pages feed', schema)).rejects.toMatchObject({ kind: 'schema' })
  })

  it('applies diagnostics to the topology loader without changing its schema', async () => {
    const env = { TOPOLOGY_URL: 'https://example.com/topology.json' } as unknown as Env
    vi.stubGlobal('fetch', async () => new Response('Missing', { status: 404 }))
    await expect(loadTopology(env)).rejects.toMatchObject({ kind: 'http', status: 404, url: env.TOPOLOGY_URL })
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ schemaVersion: 2 })))
    await expect(loadTopology(env)).rejects.toMatchObject({ kind: 'schema' })
  })

  it('does not cache a failed feed request or poison later tool calls', async () => {
    const env = { PAGES_EN_URL: feedUrl, PAGES_FR_URL: 'https://example.com/pages.fr.json' } as unknown as Env
    vi.stubGlobal('fetch', async () => new Response('Unavailable', { status: 503 }))
    await expect(loadPages(env)).rejects.toMatchObject({ kind: 'http' })
    vi.stubGlobal('fetch', async () => new Response('[]'))
    await expect(loadPages(env)).resolves.toEqual([])
  })
})

describe('remote document deadlines', () => {
  it('settles once and aborts even when fetch ignores cancellation', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const fetch = vi.fn((_input: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    })
    vi.stubGlobal('fetch', fetch)
    const pending = loadPagesFeed(feedUrl)
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout', message: expect.stringContaining(`${REMOTE_DOCUMENT_TIMEOUT_MS}ms`) })
    await vi.advanceTimersByTimeAsync(REMOTE_DOCUMENT_TIMEOUT_MS)
    await assertion
    expect(signal?.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('includes a stalled response body in the same deadline', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ start() {} })))
    const pending = loadRemoteText(feedUrl, 'pages feed', 'application/json')
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(REMOTE_DOCUMENT_TIMEOUT_MS)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds Markdown retrieval and clears the timer after success', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => new Response('# Page'))
    vi.stubGlobal('fetch', fetch)
    const page = { id: 'page', locale: 'en' as const, type: 'page', title: 'Page', url: 'https://example.com/page', markdownUrl: 'https://example.com/page.md' }
    await expect(retrievePage(page)).resolves.toBe('# Page')
    expect(fetch).toHaveBeenCalledWith(page.markdownUrl, expect.objectContaining({
      headers: expect.any(Headers),
      signal: expect.any(AbortSignal),
    }))
    expect(vi.getTimerCount()).toBe(0)
  })
})
