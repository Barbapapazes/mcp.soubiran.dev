import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('worker integration', () => {
  it('serves the domain verification token through the real entrypoint', async () => {
    const response = await exports.default.fetch('https://mcp.soubiran.dev/.well-known/openai-apps-challenge')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
    expect(await response.text()).toBe('TDwUyOcyufhOWyEr7ZNrPlWMP07hOvF5528GqXCk6Mk')
  })

  it('redirects unknown routes through the real entrypoint', async () => {
    const response = await exports.default.fetch('https://mcp.soubiran.dev/unknown', { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('https://soubiran.dev/')
    await response.text()
  })
})
