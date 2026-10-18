import * as Sentry from '@sentry/cloudflare'
import { describe, expect, it } from 'vitest'
import config from '../cloudflare.config'

const VERSION_ID = '54065f59-1017-4494-bb46-d8d9ead7e584'

async function observedRelease(versionId?: string) {
  const pending: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise) },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext
  const env = {
    ...(versionId ? { CF_VERSION_METADATA: { id: versionId, tag: 'test', timestamp: '2026-01-01T00:00:00Z' } } : {}),
  } as Env
  const handler = Sentry.withSentry(
    (env: Env) => ({
      dsn: env.SENTRY_DSN ?? 'https://public@example.invalid/1',
      defaultIntegrations: [],
      // No network: this test only inspects the SDK options inside the request scope.
      transport: () => ({ send: async () => ({ statusCode: 200 }), flush: async () => true }),
    }),
    {
      fetch: async (_request: Request, _env: Env, _ctx: ExecutionContext) => Response.json({ release: Sentry.getClient()?.getOptions().release ?? null }),
    },
  )
  const response = await handler.fetch(new Request('https://mcp.example.com/mcp'), env, ctx)
  const result = await response.json() as { release: string | null }
  await Promise.all(pending)
  return result.release
}

describe('Worker deployment policy', () => {
  it('explicitly disables public version and branch preview URLs in the active config', () => {
    expect(config.worker.previewUrls).toBe(false)
  })

  it('declares the version metadata binding under the name the Sentry SDK reads', () => {
    expect(config.worker.env.CF_VERSION_METADATA).toEqual({ type: 'version-metadata' })
  })

  it('lets the installed SDK correlate events with the running version inside its request scope', async () => {
    expect(await observedRelease(VERSION_ID)).toBe(VERSION_ID)
  })

  it('does not invent a release for local environments without version metadata', async () => {
    expect(await observedRelease()).toBeNull()
  })
})
