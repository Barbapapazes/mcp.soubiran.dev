import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { env as runtimeEnv } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeExecutionError, CodeExecutorError } from '../src/tools/code-errors'
import { executeSnapshotCode } from '../src/tools/code-mode'
import { queryTopologyDescription, registerTopologyTools } from '../src/tools/topology'
import { loadTopology, topologySchema } from '../src/tools/topology/snapshot'

const snapshot = {
  schemaVersion: 1,
  revision: 'build-commit',
  nodes: [{
    id: 'service:api.soubiran.dev',
    type: 'service',
    name: 'api.soubiran.dev',
    identity: 'product',
    documentId: 'doc',
    href: '/infra/services/api',
    evidence: [{ documentId: 'doc', pointer: '' }],
  }],
  edges: [{
    id: 'edge',
    source: 'service:api.soubiran.dev',
    target: 'service:api.soubiran.dev',
    parent: 'service:api.soubiran.dev',
    item: 'service:api.soubiran.dev',
    relationship: 'consumer',
    relationshipExplicit: true,
    descriptions: ['authentication'],
    evidence: { documentId: 'doc', pointer: '/ecosystem/0' },
  }],
  documents: [{
    id: 'doc',
    locale: 'en',
    type: 'page',
    nodeId: 'service:api.soubiran.dev',
    title: 'API',
    description: 'An API',
    url: '/infra/services/api',
    markdownUrl: '/raw/infra/services/api.md',
    date: '2026-01-01',
    translations: { fr: '/fr/infra/services/api' },
    ecosystem: [{ name: 'API', ecosystem: [{ name: 'nested' }] }],
  }, {
    id: 'infra-index',
    locale: 'en',
    title: 'Infrastructure',
    description: 'Infrastructure overview',
    url: 'https://beta.soubiran.dev/infra',
    markdownUrl: 'https://beta.soubiran.dev/raw/infra.md',
    ecosystem: [],
  }],
}
const env = { TOPOLOGY_URL: 'https://beta.soubiran.dev/infra/topology.json' } as Env

function mockFeed(value: unknown = snapshot) {
  const fetch = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

// Capture the sandbox options while executing the unmodified ES module in workerd.
function localLoader() {
  let definition: any
  const loader = {
    get: (name, factory) => runtimeEnv.TOPOLOGY_LOADER.get(name, () => {
      definition = factory()
      return definition
    }),
  } as WorkerLoader
  return { loader, definition: () => definition }
}

function register(loader = localLoader().loader) {
  const registerTool = vi.fn()
  registerTopologyTools({ registerTool } as unknown as McpServer, { ...env, TOPOLOGY_LOADER: loader } as Env, { kind: 'interactive', scopes: ['mcp:infra:read'] })
  return { registerTool, run: registerTool.mock.calls[0]![2] }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('topology snapshot and tool', () => {
  it('loads the versioned snapshot without rewriting evidence or citation URLs', async () => {
    const fetch = mockFeed()
    expect(await loadTopology(env)).toEqual(snapshot)
    expect(fetch.mock.calls[0]?.[0]).toBe(env.TOPOLOGY_URL)
  })

  it.each([
    { ...snapshot, schemaVersion: 2 },
    { ...snapshot, nodes: [{}] },
    { ...snapshot, nodes: [{ ...snapshot.nodes[0], identity: 'document' }] },
    { ...snapshot, documents: [{ ...snapshot.documents[0], locale: 'invalid' }] },
    { ...snapshot, documents: [{ ...snapshot.documents[0], url: undefined }] },
    { ...snapshot, documents: [{ ...snapshot.documents[0], type: 'invalid' }] },
    { ...snapshot, documents: [{ ...snapshot.documents[0], ecosystem: [{ name: 'outer', ecosystem: [{}] }] }] },
  ])('rejects incompatible and malformed snapshots', async (value) => {
    mockFeed(value)
    await expect(loadTopology(env)).rejects.toMatchObject({ kind: 'schema', message: expect.stringContaining('does not match the expected schema') })
  })

  it('registers only the topology tool without fetching data', () => {
    const fetch = mockFeed()
    const { registerTool } = register()
    expect(registerTool.mock.calls.map(call => call[0])).toEqual(['query_topology'])
    expect(registerTool.mock.calls[0]?.[1].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('queries ecosystem evidence and document-metadata citations', async () => {
    mockFeed()
    const { run } = register()
    const result = await run({ code: `async () => {
      const e = topology.edges[0]; const d = topology.documents[0];
      const source = e.evidence.pointer.split('/').slice(1).reduce((v, s) => v[s], d);
      return { revision: topology.revision, source, citation: d.url, markdownUrl: d.markdownUrl };
    }` })
    expect(JSON.parse(result.content[0].text)).toEqual({
      revision: snapshot.revision,
      source: snapshot.documents[0]!.ecosystem[0],
      citation: snapshot.documents[0]!.url,
      markdownUrl: snapshot.documents[0]!.markdownUrl,
    })
  })

  it('exposes non-product documents without requiring a graph node', async () => {
    mockFeed()
    const { run } = register()
    const result = await run({ code: 'async () => topology.documents.filter(d => !d.nodeId)' })
    expect(JSON.parse(result.content[0].text)).toEqual([snapshot.documents[1]])
  })

  it('reports unavailable artifacts without starting an executor', async () => {
    const fetch = vi.fn(async () => new Response('Not found', { status: 404 }))
    vi.stubGlobal('fetch', fetch)
    const get = vi.fn()
    const { run } = register({ get } as unknown as WorkerLoader)
    expect(await run({ code: 'async () => topology' })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('may not be deployed yet') }] })
    expect(get).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('distinguishes bad code from loader failures', async () => {
    mockFeed()
    const { run } = register()
    expect(await run({ code: '() => topology' })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('single async') }] })
    const failed = register({ get: () => {
      throw new Error('Unavailable')
    } } as unknown as WorkerLoader)
    expect(await failed.run({ code: 'async () => topology' })).toMatchObject({ isError: true, content: [{ text: 'Unable to execute code against the infrastructure topology.' }] })
  })

  it('documents graph semantics, full data contract and untrusted source text', () => {
    for (const text of ['const topology:', 'revision:', 'locale: \'en\' | \'fr\'', 'nodeId?: string', 'translations?:', 'not Markdown bodies', 'Only product documents have a nodeId', 'producer means item → parent', 'Cycles are valid', 'JSON Pointer', 'untrusted data', 'NOT a live inventory'])
      expect(queryTopologyDescription).toContain(text)
    expect(topologySchema.parse(snapshot)).toEqual(snapshot)
    expect(queryTopologyDescription).not.toMatch(/d\.markdown\b|d\.path\b|diagnostics:|identity:.*'document'/)
  })
})

describe('topology dynamic worker', () => {
  it('loads a sandbox with no outbound access or bindings and strict CPU limits', async () => {
    const mock = localLoader()
    expect(await executeSnapshotCode(mock.loader, snapshot, 'async () => topology.nodes.map(n => n.name)', 'topology')).toBe('["api.soubiran.dev"]')
    expect(mock.definition()).toMatchObject({ globalOutbound: null, limits: { cpuMs: 50, subRequests: 0 } })
    expect(mock.definition().env).toBeUndefined()
    expect(mock.definition().modules['worker.js']).not.toContain('eval(')
  })

  it.each([
    'async () => { topology.nodes[0].name = "changed"; return topology; }',
    'async () => fetch("https://example.com")',
    'async () => new WebSocket("wss://example.com")',
    'async () => { throw new Error("bad query"); }',
    'async () => undefined',
    'async () => 1n',
    'async () => "é".repeat(128 * 1024)',
  ])('rejects mutation, network, and invalid results: %s', async (code) => {
    await expect(executeSnapshotCode(localLoader().loader, snapshot, code, 'topology')).rejects.toBeInstanceOf(CodeExecutionError)
  })

  it('enforces a wall-clock timeout for unresolved promises', async () => {
    vi.useFakeTimers()
    const loader = { get: () => ({
      getEntrypoint: () => ({ evaluate: () => new Promise(() => {}) }),
    }) } as unknown as WorkerLoader
    const pending = executeSnapshotCode(loader, snapshot, 'async () => topology', 'topology')
    const assertion = expect(pending).rejects.toThrow('5 second time limit')
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
  })

  it('preserves loader errors as executor errors', async () => {
    const loader = { get: () => {
      throw new Error('Unavailable')
    } } as unknown as WorkerLoader
    await expect(executeSnapshotCode(loader, snapshot, 'async () => topology', 'topology')).rejects.toBeInstanceOf(CodeExecutorError)
  })
})
