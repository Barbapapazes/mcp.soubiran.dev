import { describe, expect, it, vi } from 'vitest'
import { shapeError } from '../src/error-context'
import { recordTool } from '../src/telemetry'

vi.mock('evlog/workers', () => ({ initWorkersLogger: vi.fn() }))

function logger() {
  return { set: vi.fn(), setLevel: vi.fn(), emit: vi.fn() }
}

describe('error context', () => {
  it('preserves wrapper and HTTP cause context without serializing payloads', () => {
    const cause = Object.assign(new Error('Catalog fetch failed'), {
      statusCode: 404,
      url: 'https://example.com/feed.json',
      data: { secret: 'do not log' },
    })
    const result = shapeError(new Error('Pages unavailable', { cause }))
    expect(result).toEqual({
      name: 'Error',
      message: 'Pages unavailable',
      cause: { name: 'Error', message: 'Catalog fetch failed', httpStatus: 404, url: 'https://example.com/feed.json' },
    })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('stack')
  })

  it('removes credentials, query parameters and fragments from URLs and messages', () => {
    const url = 'https://user:password@example.com/feed.json?token=secret#private'
    expect(shapeError({ message: `[GET] "${url}": 403`, url })).toEqual({
      message: '[GET] "https://example.com/feed.json": 403',
      url: 'https://example.com/feed.json',
    })
  })

  it('terminates circular and excessively deep cause chains', () => {
    const first = new Error('First')
    const second = new Error('Second', { cause: first })
    first.cause = second
    expect(shapeError(first).cause?.cause).toEqual({ message: 'Circular error cause.' })

    let deep = new Error('Leaf')
    for (let i = 0; i < 20; i++)
      deep = new Error('Wrapper', { cause: deep })
    expect(shapeError(deep).cause?.cause?.cause?.cause).toEqual({ message: 'Error cause depth limit reached.' })
  })

  it('handles non-errors and hostile properties using only bounded primitive fields', () => {
    expect(shapeError(null)).toEqual({ message: 'Unexpected error.' })
    expect(shapeError('Failure')).toEqual({ message: 'Failure' })
    expect(shapeError({ message: 'x'.repeat(1_000), status: 502 }).message).toHaveLength(512)
    expect(shapeError({ message: { secret: true }, status: { secret: true } })).toEqual({ message: 'Unexpected error.' })
    const hostile = new Proxy({}, { get() {
      throw new Error('Getter failed')
    } })
    expect(shapeError(hostile)).toEqual({ message: 'Unexpected error.' })
  })
})

describe('tool failure events', () => {
  it('emits one event with static metadata and shaped upstream context', () => {
    const log = logger()
    recordTool(log, 'query_topology', performance.now(), 'upstream_error', { errorCode: 'TOPOLOGY_RETRIEVAL_FAILED' }, new Error('Snapshot unavailable'))
    expect(log.setLevel).toHaveBeenCalledWith('error')
    expect(log.set).toHaveBeenCalledWith({ mcp: { tools: [{
      name: 'query_topology',
      outcome: 'upstream_error',
      durationMs: expect.any(Number),
      errorCode: 'TOPOLOGY_RETRIEVAL_FAILED',
      error: { name: 'Error', message: 'Snapshot unavailable' },
    }] } })
    expect(log.emit).toHaveBeenCalledTimes(1)
  })

  it('does not add error text to success or client-code events without an error argument', () => {
    const log = logger()
    recordTool(log, 'list_pages', performance.now(), 'client_error', { errorCode: 'CONTENT_CODE_EXECUTION_FAILED' })
    expect(log.setLevel).toHaveBeenCalledWith('warn')
    expect(log.set.mock.calls[0]![0].mcp.tools[0]).not.toHaveProperty('error')
    expect(log.emit).toHaveBeenCalledTimes(1)
  })
})
