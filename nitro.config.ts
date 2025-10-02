import { defineNitroConfig } from 'nitropack/config'

export default defineNitroConfig({
  runtimeConfig: {
    baseMcpUrl: 'https://soubiran.dev/api/mcp',
  },

  compatibilityDate: 'latest',
  srcDir: 'server',

  cloudflare: {
    nodeCompat: true,
    deployConfig: true,
    wrangler: {
      name: 'mcp-soubiran-dev',
      observability: {
        enabled: true,
        head_sampling_rate: 0.1,
      },
    },
  },

  unenv: {
    alias: {
      'safer-buffer': 'node:buffer',
    },
  },
})
