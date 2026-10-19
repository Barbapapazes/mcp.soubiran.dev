import { afterEach, expect, it, vi } from 'vitest'
import { CONTENT_RESOURCE, CONTENT_SCOPE, INFRA_RESOURCE, INFRA_SCOPE, PASSPORT_ISSUER } from '../src/auth'
import { protectedResource } from '../src/resource-server'

vi.mock('../src/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/auth')>(),
  validatePassportToken: vi.fn(),
}))
const { validatePassportToken } = await import('../src/auth')
const validate = vi.mocked(validatePassportToken)
const env = { CORS_ALLOWED_ORIGIN: 'https://example.com' } as Env
const ctx = {} as ExecutionContext

afterEach(() => vi.resetAllMocks())

it.each([
  [CONTENT_RESOURCE, CONTENT_SCOPE],
  [INFRA_RESOURCE, INFRA_SCOPE],
])('advertises Passport as the only authorization server for %s', async (resource, scope) => {
  const handler = vi.fn()
  const url = `https://mcp.soubiran.dev/.well-known/oauth-protected-resource${new URL(resource).pathname}`
  const response = await protectedResource(resource, handler).fetch(new Request(url), env, ctx)
  expect(await response.json()).toEqual({
    resource, authorization_servers: [PASSPORT_ISSUER], scopes_supported: [scope], bearer_methods_supported: ['header'],
  })
  expect(validate).not.toHaveBeenCalled()
  expect(handler).not.toHaveBeenCalled()
})

it('allows browser preflight without authenticating', async () => {
  const handler = vi.fn()
  const response = await protectedResource(CONTENT_RESOURCE, handler).fetch(new Request(CONTENT_RESOURCE, { method: 'OPTIONS' }), env, ctx)
  expect(response.status).toBe(204)
  expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization')
  expect(validate).not.toHaveBeenCalled()
  expect(handler).not.toHaveBeenCalled()
})

it.each([undefined, 'Bearer old-worker-token', 'Basic credentials', 'Bearer malformed.jwt.token'])('rejects untrusted credentials %s without invoking tools', async (authorization) => {
  validate.mockResolvedValue(null)
  const handler = vi.fn()
  const request = new Request(CONTENT_RESOURCE, { headers: authorization ? { Authorization: authorization } : {} })
  const response = await protectedResource(CONTENT_RESOURCE, handler).fetch(request, env, ctx)
  expect(response.status).toBe(401)
  expect(response.headers.get('WWW-Authenticate')).toContain('resource_metadata="https://mcp.soubiran.dev/.well-known/oauth-protected-resource/mcp"')
  expect(response.headers.get('Access-Control-Expose-Headers')).toContain('WWW-Authenticate')
  expect(response.headers.get('WWW-Authenticate')?.includes('invalid_token')).toBe(Boolean(authorization))
  expect(handler).not.toHaveBeenCalled()
})

it('returns insufficient_scope for an authenticated user without the required permission', async () => {
  validate.mockResolvedValue({ audience: CONTENT_RESOURCE, expiresAt: Date.now() / 1000 + 60, scope: [], props: { kind: 'interactive', scopes: [] }, userId: '42' })
  const handler = vi.fn()
  const response = await protectedResource(CONTENT_RESOURCE, handler).fetch(new Request(CONTENT_RESOURCE, { headers: { Authorization: 'Bearer passport-token' } }), env, ctx)
  expect(response.status).toBe(403)
  expect(response.headers.get('WWW-Authenticate')).toContain('error="insufficient_scope"')
  expect(handler).not.toHaveBeenCalled()
})

it('never permits a service principal on the infrastructure endpoint', async () => {
  validate.mockResolvedValue({ audience: INFRA_RESOURCE, expiresAt: Date.now() / 1000 + 60, scope: [INFRA_SCOPE], props: { kind: 'service', scopes: [INFRA_SCOPE] }, userId: 'client' })
  const handler = vi.fn()
  const response = await protectedResource(INFRA_RESOURCE, handler).fetch(new Request(INFRA_RESOURCE, { headers: { Authorization: 'Bearer passport-token' } }), env, ctx)
  expect(response.status).toBe(403)
  expect(handler).not.toHaveBeenCalled()
})
