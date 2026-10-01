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

const { default: worker } = await import('../src/index')
const env = { CORS_ALLOWED_ORIGIN: 'https://example.com' } as unknown as Env
const ctx = {} as ExecutionContext

beforeEach(() => {
  vi.clearAllMocks()
  handleMcp.mockResolvedValue(new Response('OK'))
})

describe('worker requests', () => {
  it('redirects other routes without creating an MCP handler', async () => {
    const response = await worker.fetch!(new Request('https://mcp.example.com/'), env, ctx)
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('https://soubiran.dev/')
    expect(createMcpHandler).not.toHaveBeenCalled()
    expect(log.emit).toHaveBeenCalledTimes(1)
  })

  it('handles MCP requests with the configured CORS origin', async () => {
    const response = await worker.fetch!(new Request('https://mcp.example.com/mcp'), env, ctx)
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

  it('records handler failures once, including duration and internal-error outcome', async () => {
    const error = new Error('Handler failed')
    handleMcp.mockRejectedValue(error)
    const response = await worker.fetch!(new Request('https://mcp.example.com/mcp'), env, ctx)
    expect(response.status).toBe(500)
    expect(await response.text()).toBe('Internal Server Error')
    expect(captureException).toHaveBeenCalledWith(error)
    expect(log.setLevel).toHaveBeenCalledWith('error')
    expect(log.set).toHaveBeenCalledWith({ mcp: { errorCode: 'MCP_HANDLER_FAILED' } })
    expect(log.set).toHaveBeenLastCalledWith({
      request: { durationMs: expect.any(Number) },
      mcp: { route: true, outcome: 'internal_error' },
    })
    expect(log.emit).toHaveBeenCalledTimes(1)
  })
})
