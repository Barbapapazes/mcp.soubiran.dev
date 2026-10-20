import { bindings, defineConfig } from 'cf/config'

const environments = {
  development: {
    siteOrigin: 'https://beta.soubiran.dev',
    corsOrigin: 'http://localhost:3000',
    publicOrigin: 'http://localhost:8787',
    passportIssuer: 'http://localhost:8000',
    passportJwksUrl: 'http://localhost:8000/.well-known/jwks.json',
  },
  production: {
    siteOrigin: 'https://soubiran.dev',
    corsOrigin: 'https://soubiran.dev',
    publicOrigin: 'https://mcp.soubiran.dev',
    passportIssuer: 'https://api.soubiran.dev',
    passportJwksUrl: 'https://api.soubiran.dev/.well-known/jwks.json',
  },
}

export default defineConfig(({ mode }) => {
  const selectedMode = mode ?? 'production'

  if (selectedMode !== 'development' && selectedMode !== 'production')
    throw new Error(`Unsupported Cloudflare mode: ${selectedMode}`)

  const values = environments[selectedMode]

  return {
    worker: {
      name: 'mcp-soubiran-dev',
      compatibilityDate: '2026-03-27',
      compatibilityFlags: [
        'nodejs_compat',
      ],
      entrypoint: 'src/index.ts',
      workersDev: false,
      previewUrls: false,
      observability: {
        enabled: true,
        issues: {
          enabled: true,
        },
        traces: {
          enabled: false,
        },
        logs: {
          enabled: true,
          persist: true,
          invocationLogs: false,
          headSamplingRate: 1,
        },
      },
      env: {
        PAGES_EN_URL: bindings.text(`${values.siteOrigin}/pages.en.json`),
        PAGES_FR_URL: bindings.text(`${values.siteOrigin}/pages.fr.json`),
        CORS_ALLOWED_ORIGIN: bindings.text(values.corsOrigin),
        MCP_PUBLIC_ORIGIN: bindings.text(values.publicOrigin),
        AI_SEARCH: bindings.aiSearchNamespace({
          namespace: 'soubiran-dev',
          dev: {
            remote: true,
          },
        }),
        CONTENT_LOADER: bindings.workerLoader(),
        TOPOLOGY_URL: bindings.text(`${values.siteOrigin}/infra/topology.json`),
        TOPOLOGY_LOADER: bindings.workerLoader(),
        SENTRY_DSN: bindings.secret(),
        // @sentry/cloudflare uses this binding's id as the default release.
        CF_VERSION_METADATA: bindings.versionMetadata(),
        PASSPORT_ISSUER: bindings.text(values.passportIssuer),
        PASSPORT_JWKS_URL: bindings.text(values.passportJwksUrl),
      },
    },
  }
})
