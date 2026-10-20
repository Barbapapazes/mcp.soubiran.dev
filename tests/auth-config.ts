import { getAuthConfig } from '../src/auth'

export const authEnv = {
  MCP_PUBLIC_ORIGIN: 'https://mcp.soubiran.dev',
  PASSPORT_ISSUER: 'https://api.soubiran.dev',
  PASSPORT_JWKS_URL: 'https://api.soubiran.dev/.well-known/jwks.json',
} as unknown as Env

const config = getAuthConfig(authEnv)
export const CONTENT_RESOURCE = config.contentResource
export const INFRA_RESOURCE = config.infraResource
export const PASSPORT_ISSUER = config.passportIssuer
