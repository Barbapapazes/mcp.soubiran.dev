import { defineNitroConfig } from 'nitropack/config'

export default defineNitroConfig({
  runtimeConfig: {
    baseMcpUrl: 'https://soubiran.dev/api/mcp',
  },

  compatibilityDate: 'latest',
  srcDir: 'server',

  cloudflare: {
    wrangler: {
      observability: {
        enabled: true,
        head_sampling_rate: 0.1,
      },
    },
  },
})
