import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { feedbackInputSchema, registerFeedbackTool } from '../src/tools/feedback'

const { recordTool, log } = vi.hoisted(() => ({
  recordTool: vi.fn(),
  log: {},
}))
vi.mock('../src/telemetry', () => ({ createToolLogger: () => log, recordTool }))

const env = {
  MCP_FEEDBACK_URL: 'https://api.soubiran.dev/api/internal/mcp-feedback',
  MCP_FEEDBACK_ACCESS_CLIENT_ID: 'worker.access',
  MCP_FEEDBACK_ACCESS_CLIENT_SECRET: 'service-secret',
  CF_VERSION_METADATA: { id: 'release-123' },
} as Env
const input = {
  task: 'Read the latest article',
  kind: 'broken' as const,
  impact: 'blocked' as const,
  description: 'The get_page tool returned an error instead of an article.',
  toolName: 'get_page',
}
const feedbackId = '00000000-0000-4000-8000-000000000001'

function register(source: 'content' | 'infrastructure' = 'content', bindings = env) {
  const registerTool = vi.fn()
  const server = {
    registerTool,
    server: { getClientVersion: () => ({ name: 'Example client', version: '1.0' }) },
  } as unknown as McpServer
  registerFeedbackTool(server, bindings, source)
  const handler = registerTool.mock.calls[0]![2] as (params: unknown) => Promise<CallToolResult>
  return { registerTool, handler }
}

function accepted(status = 201) {
  return new Response(JSON.stringify({ data: { id: feedbackId } }), { status })
}

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MCP feedback', () => {
  it('registers an explicitly non-read-only reporting tool without network calls', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { registerTool } = register()
    expect(registerTool).toHaveBeenCalledWith('submit_mcp_feedback', expect.objectContaining({
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      outputSchema: expect.objectContaining({ feedbackId: expect.anything() }),
    }), expect.any(Function))
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['content', 'infrastructure'] as const)('persists a %s report before returning its ID', async (source) => {
    const fetch = vi.fn().mockResolvedValue(accepted())
    vi.stubGlobal('fetch', fetch)
    const { handler } = register(source)
    const result = await handler(input)

    expect(result).toMatchObject({ structuredContent: { feedbackId } })
    expect(fetch).toHaveBeenCalledWith(env.MCP_FEEDBACK_URL, expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      headers: expect.objectContaining({
        'CF-Access-Client-Id': 'worker.access',
        'CF-Access-Client-Secret': 'service-secret',
      }),
    }))
    const report = JSON.parse(fetch.mock.calls[0]![1].body)
    expect(report).toMatchObject({
      task: input.task,
      description: input.description,
      kind: 'broken',
      impact: 'blocked',
      tool_name: 'get_page',
      source,
      release: 'release-123',
      client_name: 'Example client',
      client_version: '1.0',
    })
    expect(report.submission_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(recordTool).toHaveBeenCalledWith(log, 'submit_mcp_feedback', expect.any(Number), 'success', {
      source: { category: source }, kind: 'broken', impact: 'blocked',
    })
    expect(JSON.stringify(recordTool.mock.calls)).not.toContain(input.description)
  })

  it('retries transient errors with exactly the same serialized submission', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('Unavailable', { status: 503 })).mockResolvedValueOnce(accepted(200))
    vi.stubGlobal('fetch', fetch)

    expect(await register().handler(input)).toMatchObject({ structuredContent: { feedbackId } })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0]![1].body).toBe(fetch.mock.calls[1]![1].body)
  })

  it('retries a network error without logging the potentially sensitive exception', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('service-secret and sensitive request')).mockResolvedValueOnce(accepted())
    vi.stubGlobal('fetch', fetch)

    expect(await register().handler(input)).toMatchObject({ structuredContent: { feedbackId } })
    expect(fetch.mock.calls[0]![1].body).toBe(fetch.mock.calls[1]![1].body)
    expect(JSON.stringify(recordTool.mock.calls)).not.toContain('service-secret')
  })

  it.each([401, 403, 409, 422, 429])('does not retry a %s rejection or claim success', async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response('Rejected', { status }))
    vi.stubGlobal('fetch', fetch)

    expect(await register().handler(input)).toMatchObject({ isError: true })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('bounds retries and reports uncertain delivery without exposing the exception', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('private-report service-secret'))
    vi.stubGlobal('fetch', fetch)

    expect(await register().handler(input)).toMatchObject({ isError: true })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(recordTool.mock.calls)).not.toContain('private-report')
    expect(JSON.stringify(recordTool.mock.calls)).not.toContain('service-secret')
  })

  it('does not claim success when the API returns a malformed receipt', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { id: 'bad-id' } })))
    vi.stubGlobal('fetch', fetch)

    expect(await register().handler(input)).toMatchObject({ isError: true })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fails without sending anything when Access credentials are absent', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    expect(await register('content', { ...env, MCP_FEEDBACK_ACCESS_CLIENT_SECRET: '' }).handler(input)).toMatchObject({ isError: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['', 'T.B.D.', 'none', 'test', 'placeholder'])('rejects placeholder description %j', async (description) => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    expect(await register().handler({ ...input, description })).toMatchObject({ isError: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects oversized input and unsupported classifications', () => {
    expect(feedbackInputSchema.safeParse({ ...input, task: 'a'.repeat(201) }).success).toBe(false)
    expect(feedbackInputSchema.safeParse({ ...input, description: 'a'.repeat(4097) }).success).toBe(false)
    expect(feedbackInputSchema.safeParse({ ...input, kind: 'other' }).success).toBe(false)
    expect(feedbackInputSchema.safeParse({ ...input, impact: 'critical' }).success).toBe(false)
  })

  it('forwards free-text report fields without redaction', async () => {
    const fetch = vi.fn().mockResolvedValue(accepted())
    vi.stubGlobal('fetch', fetch)
    await register().handler({
      ...input,
      task: 'Read with Bearer task-secret',
      description: 'Request failed with api_key=private-key and Bearer report-secret',
      toolName: 'password=tool-secret',
    })
    const body = JSON.parse(fetch.mock.calls[0]![1].body)
    expect(body).toMatchObject({
      task: 'Read with Bearer task-secret',
      description: 'Request failed with api_key=private-key and Bearer report-secret',
      tool_name: 'password=tool-secret',
    })
  })
})
