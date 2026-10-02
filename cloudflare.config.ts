import { bindings, defineConfig } from 'cf/config'

export default defineConfig({
  worker: {
    name: 'mcp-soubiran-dev',
    compatibilityDate: '2026-03-27',
    compatibilityFlags: [
      'nodejs_compat',
    ],
    entrypoint: 'src/index.ts',
    observability: {
      enabled: true,
      issues: {
        enabled: true,
      },
      traces: {
        enabled: true,
        persist: true,
        headSamplingRate: 1,
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
      SENTRY_DSN: bindings.secret(),
    },
  },
})
