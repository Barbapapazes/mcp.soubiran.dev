import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The first entrypoint request also transforms the Worker dependency graph.
    testTimeout: 30_000,
  },
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      // Production uses cf/config, not a Wrangler worker configuration.
      // Keep tests local: no remote AI Search binding or production secrets.
      miniflare: {
        compatibilityDate: '2026-03-27',
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          PAGES_EN_URL: 'https://beta.soubiran.dev/pages.en.json',
          PAGES_FR_URL: 'https://beta.soubiran.dev/pages.fr.json',
          CORS_ALLOWED_ORIGIN: 'https://example.com',
          TOPOLOGY_URL: 'https://beta.soubiran.dev/infra/topology.json',
          QUICK_NEWS_API_URL: 'https://api.soubiran.dev/api/quick-news',
        },
        workerLoaders: {
          CONTENT_LOADER: {},
          TOPOLOGY_LOADER: {},
        },
      },
    }),
  ],
})
