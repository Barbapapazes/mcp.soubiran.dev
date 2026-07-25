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

export function recordTool(
  log: TelemetryLogger,
  tool: string,
  startedAt: number,
  outcome: ToolOutcome,
  details: Record<string, unknown> = {},
) {
  if (outcome !== 'success')
    log.setLevel(outcome === 'client_error' ? 'warn' : 'error')

  log.set({
    mcp: {
      tools: [{
        name: tool,
        outcome,
        durationMs: Math.round(performance.now() - startedAt),
        ...details,
      }],
    },
  })
  log.emit()
}
