import type { JWTPayload } from 'jose'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canUseTool, CONTENT_RESOURCE, CONTENT_SCOPE, INFRA_RESOURCE, validateServiceToken } from '../src/auth'
import { protectedResource } from '../src/oauth'
import { registerContentTools } from '../src/tools/content'
import { registerTopologyTools } from '../src/tools/topology'

const { privateKey, publicKey } = await generateKeyPair('RS256')
const jwk = { ...await exportJWK(publicKey), alg: 'RS256', use: 'sig' }
const env = {
  PASSPORT_SERVICE_CLIENT_ID: 'dedicated-assistant',
  PASSPORT_JWKS_URL: 'https://api.soubiran.dev/.well-known/jwks.json',
} as Env
const now = Math.floor(Date.now() / 1000)

async function token(overrides: JWTPayload = {}, algorithm = 'RS256', key = privateKey) {
  return new SignJWT({
    aud: 'dedicated-assistant', sub: 'dedicated-assistant', scopes: [CONTENT_SCOPE],
    iat: now, nbf: now - 1, exp: now + 299, jti: 'passport-token', ...overrides,
  }).setProtectedHeader({ alg: algorithm }).sign(key)
}

function mockJwks() {
  const fetch = vi.fn(async (_input: string | URL | Request) => Response.json({ keys: [jwk] }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

afterEach(() => vi.unstubAllGlobals())

describe('Passport service credentials', () => {
  it('accepts the real Passport profile without iss or kid and caches the trusted JWKS', async () => {
    const fetch = mockJwks()
    const credential = await token()
    expect(await validateServiceToken(credential, CONTENT_RESOURCE, env)).toMatchObject({
      audience: CONTENT_RESOURCE, scope: [CONTENT_SCOPE], props: { kind: 'service' },
    })
    expect(await validateServiceToken(credential, CONTENT_RESOURCE, env)).not.toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0]?.[0])).toBe(env.PASSPORT_JWKS_URL)
  })

  it.each([
    { aud: 'another-api-client' }, { aud: ['dedicated-assistant', 'another-client'] },
    { sub: 'a-user' }, { scopes: [] }, { scopes: ['*'] },
    { scopes: [CONTENT_SCOPE, 'mcp:infra:read'] }, { scope: CONTENT_SCOPE, scopes: undefined },
    { exp: now - 1 }, { nbf: now + 100 }, { exp: undefined }, { nbf: undefined },
    { iat: now - 600 }, { exp: now + 3600 }, { iss: 'https://attacker.test' },
  ])('rejects invalid claims %j', async (claims) => {
    mockJwks()
    expect(await validateServiceToken(await token(claims), CONTENT_RESOURCE, env)).toBeNull()
  })

  it('rejects a forged signature and a different algorithm', async () => {
    mockJwks()
    const other = await generateKeyPair('RS256')
    expect(await validateServiceToken(await token({}, 'RS256', other.privateKey), CONTENT_RESOURCE, env)).toBeNull()
    const ec = await generateKeyPair('ES256')
    expect(await validateServiceToken(await token({}, 'ES256', ec.privateKey), CONTENT_RESOURCE, env)).toBeNull()
  })

  it('never accepts service tokens on the infrastructure resource', async () => {
    const fetch = mockJwks()
    expect(await validateServiceToken(await token(), INFRA_RESOURCE, env)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails closed when the JWKS cannot be obtained', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await validateServiceToken(await token(), CONTENT_RESOURCE, { ...env, PASSPORT_JWKS_URL: 'https://api.soubiran.dev/unavailable-jwks' })).toBeNull()
  })

  it('does not send Passport tokens to the interactive validator or accept malformed JWTs', async () => {
    mockJwks()
    const handler = vi.fn(async () => new Response('OK'))
    const resource = protectedResource(CONTENT_RESOURCE, handler)
    const response = await resource.fetch(new Request(CONTENT_RESOURCE, { headers: { Authorization: 'Bearer malformed.jwt.token' } }), env, {} as ExecutionContext)
    expect(response.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('tool permissions', () => {
  it('allows exactly the three content tools to the service', () => {
    const principal = { kind: 'service', scopes: [CONTENT_SCOPE] } as const
    for (const tool of ['search_content', 'list_pages', 'get_page'])
      expect(canUseTool({ ...principal, scopes: [...principal.scopes] }, tool)).toBe(true)
    expect(canUseTool({ ...principal, scopes: [...principal.scopes, 'mcp:infra:read'] }, 'query_topology')).toBe(false)
    expect(canUseTool({ ...principal, scopes: [...principal.scopes] }, 'future_tool')).toBe(false)
  })

  it('checks authorization inside every callback before any upstream work', async () => {
    const registerTool = vi.fn()
    const server = { registerTool } as unknown as McpServer
    registerContentTools(server, env, { kind: 'service', scopes: [] })
    registerTopologyTools(server, env, { kind: 'service', scopes: ['mcp:infra:read'] })
    const fetch = mockJwks()
    for (const [, , callback] of registerTool.mock.calls)
      await expect(callback({ query: 'test', code: 'async () => []', id: 'page' })).rejects.toThrow('Tool access denied')
    expect(fetch).not.toHaveBeenCalled()
    expect(canUseTool({ kind: 'interactive', scopes: [CONTENT_SCOPE], expiresAt: now - 1 }, 'get_page')).toBe(false)
  })
})
