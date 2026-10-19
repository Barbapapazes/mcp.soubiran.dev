import { bindings, defineConfig } from 'cf/config'

export default defineConfig({
  worker: {
    name: 'mcp-soubiran-dev',
    compatibilityDate: '2026-03-27',
    compatibilityFlags: [
      'nodejs_compat',
      'global_fetch_strictly_public',
    ],
    entrypoint: 'src/index.ts',
    // Branch versions must not expose public endpoints with production bindings.
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
      PAGES_EN_URL: bindings.text('https://beta.soubiran.dev/pages.en.json'),
      PAGES_FR_URL: bindings.text('https://beta.soubiran.dev/pages.fr.json'),
      CORS_ALLOWED_ORIGIN: bindings.text('http://localhost:3000'),
      AI_SEARCH: bindings.aiSearchNamespace({
        namespace: 'soubiran-dev',
        dev: {
          remote: true,
        },
      }),
      CONTENT_LOADER: bindings.workerLoader(),
      TOPOLOGY_URL: bindings.text('https://beta.soubiran.dev/infra/topology.json'),
      TOPOLOGY_LOADER: bindings.workerLoader(),
      SENTRY_DSN: bindings.secret(),
      // @sentry/cloudflare uses this binding's id as the default release.
      CF_VERSION_METADATA: bindings.versionMetadata(),
      OAUTH_KV: bindings.kv(),
      PASSPORT_JWKS_URL: bindings.text('https://api.soubiran.dev/.well-known/jwks.json'),
      PASSPORT_SERVICE_CLIENT_ID: bindings.secret(),
      PASSPORT_INTERACTIVE_CLIENT_ID: bindings.secret(),
      PASSPORT_INTERACTIVE_CLIENT_SECRET: bindings.secret(),
    },
  },
})
