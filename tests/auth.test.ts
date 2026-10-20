import type { JWTPayload } from 'jose'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canUseTool, CONTENT_SCOPE, INFRA_SCOPE, validatePassportToken } from '../src/auth'
import { protectedResource } from '../src/resource-server'
import { registerContentTools } from '../src/tools/content'
import { registerTopologyTools } from '../src/tools/topology'
import { authEnv, CONTENT_RESOURCE, INFRA_RESOURCE, PASSPORT_ISSUER } from './auth-config'

const { privateKey, publicKey } = await generateKeyPair('RS256')
const jwk = { ...await exportJWK(publicKey), alg: 'RS256', use: 'sig' }
const env = authEnv
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

describe('public MCP authentication', () => {
  it.each([CONTENT_RESOURCE, INFRA_RESOURCE])('rejects former service credentials on %s', async (resource) => {
    mockJwks()
    expect(await validatePassportToken(await token(), resource, env)).toBeNull()
  })

  it('fails closed when the JWKS cannot be obtained', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await validatePassportToken(await token({ aud: CONTENT_RESOURCE, iss: PASSPORT_ISSUER, sub: '42' }), CONTENT_RESOURCE, { ...env, PASSPORT_JWKS_URL: 'https://api.soubiran.dev/unavailable-jwks' } as unknown as Env)).toBeNull()
  })

  it('does not accept malformed JWTs', async () => {
    mockJwks()
    const handler = vi.fn(async () => new Response('OK'))
    const resource = protectedResource(CONTENT_RESOURCE, handler)
    const response = await resource.fetch(new Request(CONTENT_RESOURCE, { headers: { Authorization: 'Bearer malformed.jwt.token' } }), env, {} as ExecutionContext)
    expect(response.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('Passport interactive resource tokens', () => {
  const userClaims = {
    aud: CONTENT_RESOURCE, iss: PASSPORT_ISSUER, sub: '42', scopes: [CONTENT_SCOPE],
  }

  it('accepts only Passport-issued resource-bound user tokens', async () => {
    mockJwks()
    const credential = await token(userClaims)
    expect(await validatePassportToken(credential, CONTENT_RESOURCE, env)).toMatchObject({
      audience: CONTENT_RESOURCE, props: { kind: 'interactive', scopes: [CONTENT_SCOPE] }, userId: '42',
    })
    expect(await validatePassportToken(credential, INFRA_RESOURCE, env)).toBeNull()
    expect(await validatePassportToken(await token({ ...userClaims, aud: INFRA_RESOURCE, scopes: [INFRA_SCOPE] }), INFRA_RESOURCE, env)).toMatchObject({
      props: { kind: 'interactive', scopes: [INFRA_SCOPE] },
    })
  })

  it.each([
    { iss: undefined }, { iss: 'https://attacker.test' }, { sub: '' },
    { aud: 'ordinary-passport-client' }, { aud: [CONTENT_RESOURCE, INFRA_RESOURCE] },
    { scopes: ['*'] }, { scopes: [INFRA_SCOPE] }, { scopes: undefined },
    { exp: now - 1 }, { exp: now + 3600 }, { nbf: now + 60 },
    { exp: undefined }, { nbf: undefined }, { iat: now - 600 },
  ])('rejects incorrect user claims %j', async (claims) => {
    mockJwks()
    expect(await validatePassportToken(await token({ ...userClaims, ...claims }), CONTENT_RESOURCE, env)).toBeNull()
  })

  it.each(['localhost', '127.0.0.1', '[::1]'])('validates local resource tokens using HTTP loopback JWKS on %s', async (host) => {
    mockJwks()
    const local = {
      ...env,
      MCP_PUBLIC_ORIGIN: 'http://localhost:8787',
      PASSPORT_ISSUER: 'http://localhost:8000',
      PASSPORT_JWKS_URL: `http://${host}:8000/.well-known/jwks.json`,
    } as unknown as Env
    const claims = { ...userClaims, aud: 'http://localhost:8787/mcp', iss: 'http://localhost:8000' }
    expect(await validatePassportToken(await token(claims), claims.aud, local)).not.toBeNull()
    expect(await validatePassportToken(await token({ ...claims, iss: PASSPORT_ISSUER }), claims.aud, local)).toBeNull()
    expect(await validatePassportToken(await token(userClaims), CONTENT_RESOURCE, local)).toBeNull()
  })

  it.each([
    'http://api.soubiran.dev/.well-known/jwks.json',
    'http://localhost.attacker.test/jwks',
    'https://user:password@api.soubiran.dev/jwks',
    'https://api.soubiran.dev/jwks?key=untrusted',
  ])('rejects unsafe configured JWKS URLs %s without fetching', async (url) => {
    const fetch = mockJwks()
    const configured = { ...env, PASSPORT_JWKS_URL: url } as unknown as Env
    expect(await validatePassportToken(await token(userClaims), CONTENT_RESOURCE, configured)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects old Worker tokens and ordinary Passport user tokens', async () => {
    mockJwks()
    expect(await validatePassportToken('old-worker-token', CONTENT_RESOURCE, env)).toBeNull()
    expect(await validatePassportToken(await token({ sub: '42' }), CONTENT_RESOURCE, env)).toBeNull()
  })

  it('rejects forged signatures and other signing algorithms', async () => {
    mockJwks()
    const other = await generateKeyPair('RS256')
    expect(await validatePassportToken(await token(userClaims, 'RS256', other.privateKey), CONTENT_RESOURCE, env)).toBeNull()
    const ec = await generateKeyPair('ES256')
    expect(await validatePassportToken(await token(userClaims, 'ES256', ec.privateKey), CONTENT_RESOURCE, env)).toBeNull()
  })

  it('caches keys fetched only from the configured trusted JWKS URL', async () => {
    const fetch = mockJwks()
    const configured = { ...env, PASSPORT_JWKS_URL: 'https://api.soubiran.dev/cache-test-jwks' } as unknown as Env
    const credential = await token(userClaims)
    expect(await validatePassportToken(credential, CONTENT_RESOURCE, configured)).not.toBeNull()
    expect(await validatePassportToken(credential, CONTENT_RESOURCE, configured)).not.toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0]?.[0])).toBe(configured.PASSPORT_JWKS_URL)
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
