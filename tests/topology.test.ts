import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runInNewContext } from 'node:vm'
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
    nodeId: 'service:api.soubiran.dev',
    title: 'API',
    description: 'An API',
    path: '/infra/services/api',
    markdownUrl: '/raw/infra/services/api.md',
    markdown: '# Authentication\n::infra-ecosystem',
    ecosystem: [{ name: 'API', ecosystem: [{ name: 'nested' }] }],
    links: [{ href: '/infra', text: 'Infrastructure' }],
  }],
  diagnostics: [{ code: 'unresolved-document-link', documentId: 'doc', href: '/infra/topology.json' }],
}
const env = { TOPOLOGY_URL: 'https://beta.soubiran.dev/infra/topology.json' } as Env

function mockFeed(value: unknown = snapshot) {
  const fetch = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

// Execute the generated module's body, not a canned RPC response. Runtime binding
// isolation still needs deployment validation on Cloudflare's Worker Loader.
function localLoader() {
  let definition: any
  const loader = {
    get: (_name: string, factory: () => unknown) => {
      definition = factory()
      return { getEntrypoint: () => {
        const source = definition.modules['worker.js']
          .replace('import { WorkerEntrypoint } from \'cloudflare:workers\'', 'class WorkerEntrypoint {}')
          .replace('export default class SnapshotCodeExecutor', 'class SnapshotCodeExecutor')
        return runInNewContext(`${source}\nnew SnapshotCodeExecutor()`, { TextEncoder }, { timeout: 500 })
      } }
    },
  } as unknown as WorkerLoader
  return { loader, definition: () => definition }
}

function register(loader = localLoader().loader) {
  const registerTool = vi.fn()
  registerTopologyTools({ registerTool } as unknown as McpServer, { ...env, TOPOLOGY_LOADER: loader } as Env)
  return { registerTool, run: registerTool.mock.calls[0]![2] }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('topology snapshot and tool', () => {
  it('loads the versioned snapshot without rewriting evidence or citation paths', async () => {
    const fetch = mockFeed()
    expect(await loadTopology(env)).toEqual(snapshot)
    expect(fetch.mock.calls[0]?.[0]).toBe(env.TOPOLOGY_URL)
  })

  it.each([
    { ...snapshot, schemaVersion: 2 },
    { ...snapshot, nodes: [{}] },
    { ...snapshot, documents: [{ ...snapshot.documents[0], ecosystem: [{ name: 'outer', ecosystem: [{}] }] }] },
  ])('rejects incompatible and malformed snapshots', async (value) => {
    mockFeed(value)
    await expect(loadTopology(env)).rejects.toThrow('unavailable or has an unsupported schema')
  })

  it('registers only the topology tool without fetching data', () => {
    const fetch = mockFeed()
    const { registerTool } = register()
    expect(registerTool.mock.calls.map(call => call[0])).toEqual(['query_topology'])
    expect(registerTool.mock.calls[0]?.[1].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('queries real embedded data, including Markdown and pointer evidence', async () => {
    mockFeed()
    const { run } = register()
    const result = await run({ code: `async () => {
      const e = topology.edges[0]; const d = topology.documents[0];
      const source = e.evidence.pointer.split('/').slice(1).reduce((v, s) => v[s], d);
      return { revision: topology.revision, source, citation: d.path, markdown: d.markdown };
    }` })
    expect(JSON.parse(result.content[0].text)).toEqual({
      revision: snapshot.revision,
      source: snapshot.documents[0]!.ecosystem[0],
      citation: snapshot.documents[0]!.path,
      markdown: snapshot.documents[0]!.markdown,
    })
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
    for (const text of ['const topology:', 'revision:', 'diagnostics:', 'producer means item → parent', 'Cycles are valid', 'JSON Pointer', 'untrusted data', 'NOT a live inventory'])
      expect(queryTopologyDescription).toContain(text)
    expect(topologySchema.parse(snapshot)).toEqual(snapshot)
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
    // VM scripts are not ES modules, so explicitly enable strict mode here.
    const strict = code.replace('async () => {', 'async () => { "use strict";')
    await expect(executeSnapshotCode(localLoader().loader, snapshot, strict, 'topology')).rejects.toBeInstanceOf(CodeExecutionError)
  })

  it('enforces a wall-clock timeout for unresolved promises', async () => {
    vi.useFakeTimers()
    const pending = executeSnapshotCode(localLoader().loader, snapshot, 'async () => new Promise(() => {})', 'topology')
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
