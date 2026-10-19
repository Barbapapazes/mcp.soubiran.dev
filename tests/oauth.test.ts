import { afterEach, expect, it, vi } from 'vitest'
import { CONTENT_RESOURCE, CONTENT_SCOPE, INFRA_RESOURCE, INFRA_SCOPE, ISSUER } from '../src/auth'
import { authorizationServer, interactive, protectedResource } from '../src/oauth'

function environment() {
  const data = new Map<string, string>()
  return {
    PASSPORT_INTERACTIVE_CLIENT_ID: 'upstream-client',
    PASSPORT_INTERACTIVE_CLIENT_SECRET: 'server-only-secret',
    OAUTH_KV: {
      async get(key: string, options?: { type?: string } | string) {
        const value = data.get(key) ?? null
        return value && (options === 'json' || (typeof options === 'object' && options?.type === 'json')) ? JSON.parse(value) : value
      },
      async put(key: string, value: string) { data.set(key, value) },
      async delete(key: string) { data.delete(key) },
      async list(options: { prefix?: string } = {}) {
        return { keys: [...data.keys()].filter(key => key.startsWith(options.prefix ?? '')).map(name => ({ name })), list_complete: true }
      },
    },
  } as unknown as Env
}

function cookies(response: Response) {
  return (response.headers.get('Set-Cookie') ?? '').split(/,(?=\s*__Host-)/).map(value => value.trim().split(';')[0]).join('; ')
}

async function setup(resource = CONTENT_RESOURCE, scope = CONTENT_SCOPE) {
  const env = environment()
  const client = await authorizationServer.getOAuthApi(env).createClient({
    clientName: '<script>evil()</script>', redirectUris: ['https://client.example/callback'],
    tokenEndpointAuthMethod: 'none', grantTypes: ['authorization_code'], responseTypes: ['code'],
  })
  const verifier = 'a'.repeat(64)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const url = new URL(`${ISSUER}/authorize`)
  url.search = new URLSearchParams({
    client_id: client.clientId, redirect_uri: client.redirectUris[0]!, response_type: 'code',
    scope, resource, code_challenge: challenge, code_challenge_method: 'S256', state: 'client-state',
  }).toString()
  return { env, client, url, verifier }
}

async function consent(url: URL, env: Env) {
  const response = await interactive(new Request(url), env)
  const html = await response.text()
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1]
  expect(handle).toBeTruthy()
  return { response, html, handle: handle! }
}

function approve(handle: string, cookie: string, decision = 'approve') {
  return new Request(`${ISSUER}/authorize`, {
    method: 'POST', headers: { Cookie: cookie }, body: new URLSearchParams({ handle, decision }),
  })
}

afterEach(() => vi.unstubAllGlobals())

it('escapes client metadata, prevents framing, and refuses approval from another browser', async () => {
  const { env, url } = await setup()
  const page = await consent(url, env)
  expect(page.html).toContain('&#60;script&#62;')
  expect(page.html).not.toContain('<script>evil()')
  expect(page.html).toContain('client.example')
  expect(page.response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
  expect((await interactive(approve(page.handle, ''), env)).status).toBe(400)
})

it('requires S256 PKCE and rejects infrastructure scopes on the content resource', async () => {
  const { env, url } = await setup()
  url.searchParams.delete('code_challenge')
  url.searchParams.delete('code_challenge_method')
  expect((await interactive(new Request(url), env)).status).toBe(400)
  const other = await setup(CONTENT_RESOURCE, INFRA_SCOPE)
  expect((await interactive(new Request(other.url), other.env)).status).toBe(400)
})

it('denies consent without contacting Passport', async () => {
  const { env, url } = await setup()
  const page = await consent(url, env)
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const response = await interactive(approve(page.handle, cookies(page.response), 'deny'), env)
  expect(response.status).toBe(302)
  expect(response.headers.get('Location')).toContain('error=access_denied')
  expect(fetch).not.toHaveBeenCalled()
})

it('exchanges upstream PKCE for a distinct Worker token bound to one resource', async () => {
  const { env, client, url, verifier } = await setup()
  const page = await consent(url, env)
  const redirect = await interactive(approve(page.handle, cookies(page.response)), env)
  expect(redirect.status).toBe(302)
  const upstream = new URL(redirect.headers.get('Location')!)
  expect(upstream.origin).toBe('https://api.soubiran.dev')
  expect(upstream.searchParams.get('code_challenge_method')).toBe('S256')
  expect(upstream.searchParams.has('client_secret')).toBe(false)

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/oauth/token')) {
      expect(String(init?.body)).toContain('code_verifier=')
      return Response.json({ access_token: 'passport-upstream-token' })
    }
    expect(String(input)).toBe('https://api.soubiran.dev/api/mcp/identity')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer passport-upstream-token')
    return Response.json({ id: 42 })
  })
  vi.stubGlobal('fetch', fetch)
  const callback = new URL(`${ISSUER}/oauth/callback`)
  callback.search = new URLSearchParams({ state: upstream.searchParams.get('state')!, code: 'passport-code' }).toString()
  expect((await interactive(new Request(callback), env)).status).toBe(400)
  const completed = await interactive(new Request(callback, { headers: { Cookie: cookies(redirect) } }), env)
  expect(completed.status).toBe(302)
  const destination = new URL(completed.headers.get('Location')!)
  expect(destination.searchParams.get('state')).toBe('client-state')
  const body = new URLSearchParams({
    grant_type: 'authorization_code', client_id: client.clientId,
    redirect_uri: client.redirectUris[0]!, code: destination.searchParams.get('code')!,
    code_verifier: verifier, resource: CONTENT_RESOURCE,
  })
  const issued = await authorizationServer.fetch(new Request(`${ISSUER}/oauth/token`, { method: 'POST', body }), env, {} as ExecutionContext)
  expect(issued.status).toBe(200)
  const tokens = await issued.json() as { access_token: string, refresh_token?: string }
  expect(tokens.access_token).not.toBe('passport-upstream-token')
  expect(tokens.refresh_token).toBeUndefined()
  expect(await authorizationServer.validateToken(CONTENT_RESOURCE, tokens.access_token, env)).toMatchObject({
    scope: [CONTENT_SCOPE], props: { kind: 'interactive', scopes: [CONTENT_SCOPE] },
  })
  expect(await authorizationServer.validateToken(INFRA_RESOURCE, tokens.access_token, env)).toBeNull()
  const handler = vi.fn(async () => new Response('OK'))
  const response = await protectedResource(INFRA_RESOURCE, handler).fetch(new Request(INFRA_RESOURCE, { headers: { Authorization: `Bearer ${tokens.access_token}` } }), env, {} as ExecutionContext)
  expect(response.status).toBe(401)
  expect(handler).not.toHaveBeenCalled()
  expect((await interactive(new Request(callback, { headers: { Cookie: cookies(redirect) } }), env)).status).toBe(400)
})
