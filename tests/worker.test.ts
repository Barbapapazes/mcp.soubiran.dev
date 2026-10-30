import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { captureException, handleMcp, createMcpHandler, log } = vi.hoisted(() => {
  const handleMcp = vi.fn()
  return {
    captureException: vi.fn(),
    handleMcp,
    createMcpHandler: vi.fn(() => handleMcp),
    log: { set: vi.fn(), setLevel: vi.fn(), emit: vi.fn() },
  }
})

vi.mock('@sentry/cloudflare', () => ({
  withSentry: (_options: unknown, handler: unknown) => handler,
  captureException,
}))
vi.mock('agents/mcp', () => ({ createMcpHandler }))
vi.mock('evlog/workers', () => ({ createWorkersLogger: () => log }))
vi.mock('../src/tools/content', () => ({ registerContentTools: vi.fn() }))
vi.mock('../src/tools/topology', () => ({ registerTopologyTools: vi.fn() }))
vi.mock('../src/tools/quick-news', () => ({ registerQuickNewsTools: vi.fn() }))

const { registerContentTools } = await import('../src/tools/content')
const { registerTopologyTools } = await import('../src/tools/topology')
const { registerQuickNewsTools } = await import('../src/tools/quick-news')

const { default: worker } = await import('../src/index')
async function fetchWorker(url: string) {
  const ctx = createExecutionContext()
  const response = await worker.fetch!(new Request(url), env, ctx)
  await waitOnExecutionContext(ctx)
  return response
}

beforeEach(() => {
  vi.clearAllMocks()
  handleMcp.mockResolvedValue(new Response('OK'))
})

describe('worker requests', () => {
  it('serves the exact OpenAI domain verification token as plain text', async () => {
    const response = await fetchWorker('https://mcp.soubiran.dev/.well-known/openai-apps-challenge')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.has('Location')).toBe(false)
    expect(await response.text()).toBe('TDwUyOcyufhOWyEr7ZNrPlWMP07hOvF5528GqXCk6Mk')
    expect(createMcpHandler).not.toHaveBeenCalled()
    expect(log.emit).toHaveBeenCalledTimes(1)
  })

  it('redirects other routes without creating an MCP handler', async () => {
    const response = await fetchWorker('https://mcp.example.com/')
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('https://soubiran.dev/')
    expect(createMcpHandler).not.toHaveBeenCalled()
    expect(log.emit).toHaveBeenCalledTimes(1)
  })

  it('handles MCP requests with the configured CORS origin', async () => {
    const response = await fetchWorker('https://mcp.example.com/mcp')
    expect(response.status).toBe(200)
    expect(createMcpHandler).toHaveBeenCalledWith(expect.anything(), {
      corsOptions: { origin: env.CORS_ALLOWED_ORIGIN },
      route: '/mcp',
    })
    expect(log.set).toHaveBeenLastCalledWith({
      request: { durationMs: expect.any(Number) },
      mcp: { route: true, outcome: 'success' },
    })
    expect(log.emit).toHaveBeenCalledTimes(1)
  })

  it('serves a separate infrastructure MCP without registering content tools', async () => {
    const response = await fetchWorker('https://mcp.soubiran.dev/infra/mcp')
    expect(response.status).toBe(200)
    expect(createMcpHandler).toHaveBeenCalledWith(expect.anything(), {
      corsOptions: { origin: env.CORS_ALLOWED_ORIGIN },
      route: '/infra/mcp',
    })
    expect(registerTopologyTools).toHaveBeenCalledTimes(1)
    expect(registerContentTools).not.toHaveBeenCalled()
    expect(log.set).toHaveBeenLastCalledWith({
      request: { durationMs: expect.any(Number) },
      mcp: { route: true, outcome: 'success' },
    })
  })

  it('serves a separate public Quick News MCP without content or topology tools', async () => {
    const response = await fetchWorker('https://mcp.soubiran.dev/quick-news/mcp')
    expect(response.status).toBe(200)
    expect(createMcpHandler).toHaveBeenCalledWith(expect.anything(), {
      corsOptions: { origin: env.CORS_ALLOWED_ORIGIN },
      route: '/quick-news/mcp',
    })
    expect(registerQuickNewsTools).toHaveBeenCalledTimes(1)
    expect(registerContentTools).not.toHaveBeenCalled()
    expect(registerTopologyTools).not.toHaveBeenCalled()
    expect(log.set).toHaveBeenLastCalledWith({
      request: { durationMs: expect.any(Number) },
      mcp: { route: true, outcome: 'success' },
    })
  })

  it('keeps the original endpoint content-only', async () => {
    await fetchWorker('https://mcp.soubiran.dev/mcp')
    expect(registerContentTools).toHaveBeenCalledTimes(1)
    expect(registerTopologyTools).not.toHaveBeenCalled()
    expect(registerQuickNewsTools).not.toHaveBeenCalled()
  })

  it('records handler failures once, including duration and internal-error outcome', async () => {
    const error = new Error('Handler failed')
    handleMcp.mockRejectedValue(error)
    const response = await fetchWorker('https://mcp.example.com/mcp')
    expect(response.status).toBe(500)
    expect(await response.text()).toBe('Internal Server Error')
    expect(captureException).toHaveBeenCalledWith(error)
    expect(log.setLevel).toHaveBeenCalledWith('error')
    expect(log.set).toHaveBeenCalledWith({ mcp: {
      errorCode: 'MCP_HANDLER_FAILED',
      error: { name: 'Error', message: 'Handler failed' },
    } })
    expect(log.set).toHaveBeenLastCalledWith({
      request: { durationMs: expect.any(Number) },
      mcp: { route: true, outcome: 'internal_error' },
    })
    expect(log.emit).toHaveBeenCalledTimes(1)
  })
})
