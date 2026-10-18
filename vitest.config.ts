import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
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
        },
        workerLoaders: {
          CONTENT_LOADER: {},
          TOPOLOGY_LOADER: {},
        },
      },
    }),
  ],
})
