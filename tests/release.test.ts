import { readFileSync } from 'node:fs'
import * as Sentry from '@sentry/cloudflare'
import { afterEach, describe, expect, it } from 'vitest'

const VERSION_ID = '54065f59-1017-4494-bb46-d8d9ead7e584'

const wrangler = JSON.parse(readFileSync('wrangler.jsonc', 'utf8')) as {
  version_metadata?: { binding?: string }
}

function executionContext(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext
}

function sentryHandler() {
  return Sentry.withSentry(
    (env: Env) => ({ dsn: env.SENTRY_DSN }),
    {
      fetch: async (_request: Request, _env: Env, _ctx: ExecutionContext) => new Response('ok'),
    },
  )
}

function workerEnv(versionId?: string): Env {
  return {
    SENTRY_DSN: 'https://public@example.com/1',
    ...(versionId
      ? { CF_VERSION_METADATA: { id: versionId, tag: 'v1', timestamp: '2026-08-22T14:24:27Z' } }
      : {}),
  } as unknown as Env
}

afterEach(async () => {
  await Sentry.close(0)
})

describe('sentry release correlation', () => {
  it('binds the Cloudflare version metadata the SDK reads its release from', () => {
    expect(wrangler.version_metadata?.binding).toBe('CF_VERSION_METADATA')
  })

  it('tags errors with the deployed Cloudflare Worker version', async () => {
    await sentryHandler().fetch(
      new Request('https://mcp.soubiran.dev/'),
      workerEnv(VERSION_ID),
      executionContext(),
    )

    expect(Sentry.getClient()?.getOptions().release).toBe(VERSION_ID)
  })

  it('cannot correlate an error to a deploy when the version metadata binding is absent', async () => {
    await sentryHandler().fetch(
      new Request('https://mcp.soubiran.dev/'),
      workerEnv(),
      executionContext(),
    )

    expect(Sentry.getClient()?.getOptions().release).toBeUndefined()
  })
})
