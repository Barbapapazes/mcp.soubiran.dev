import type { RequestLogger } from 'evlog'
import { createLogger } from 'evlog'
import { initWorkersLogger } from 'evlog/workers'

type ToolOutcome = 'success' | 'client_error' | 'upstream_error' | 'internal_error'

export type TelemetryLogger = Pick<RequestLogger, 'emit' | 'set' | 'setLevel'>

initWorkersLogger({
  env: { service: 'mcp-soubiran-dev' },
  sampling: {
    rates: { debug: 0, info: 10, warn: 100, error: 100 },
    keep: [{ duration: 1_000 }, { status: 400 }],
  },
  redact: {
    paths: [
      '**.authorization',
      '**.cookie',
      '**.input',
      '**.output',
      '**.query',
      '**.content',
      '**.excerpt',
      '**.markdown',
    ],
  },
})

export function createToolLogger() {
  return createLogger({ operation: 'mcp.tool' })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function shapeError(error: unknown): Record<string, unknown> {
  const candidate: Record<string, unknown> = isRecord(error)
    ? error
    : error instanceof Error
      ? error as unknown as Record<string, unknown>
      : {}

  if (typeof candidate.statusCode === 'number' || typeof candidate.status === 'number') {
    return {
      message: candidate.message,
      httpStatus: candidate.statusCode ?? candidate.status,
      httpStatusText: typeof candidate.statusMessage === 'string' ? candidate.statusMessage : candidate.statusText,
      url: typeof candidate.url === 'string' ? candidate.url : undefined,
    }
  }

  // Tagged-error wrappers (ContentDirectoryError, ContentRetrievalError, ...) keep the
  // upstream failure in `cause`; surface its HTTP context when the wrapper has none.
  const cause = candidate.cause
  if (isRecord(cause) || cause instanceof Error) {
    return shapeError(cause)
  }

  return { message: typeof candidate.message === 'string' ? candidate.message : String(error) }
}

export function recordTool(
  log: TelemetryLogger,
  tool: string,
  startedAt: number,
  outcome: ToolOutcome,
  details: Record<string, unknown> = {},
  error?: unknown,
) {
  if (outcome !== 'success')
    log.setLevel(outcome === 'client_error' ? 'warn' : 'error')

  log.set({
    mcp: {
      tools: [{
        name: tool,
        outcome,
        durationMs: Math.round(performance.now() - startedAt),
        ...(error !== undefined ? { error: shapeError(error) } : {}),
        ...details,
      }],
    },
  })
  log.emit()
}
