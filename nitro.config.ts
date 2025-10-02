import { defineNitroConfig } from 'nitropack/config'

export default defineNitroConfig({
  runtimeConfig: {
    baseMcpUrl: 'https://soubiran.dev/api/mcp',
  },

  compatibilityDate: 'latest',
  srcDir: 'server',

  preset: 'cloudflare-module',

  cloudflare: {
    nodeCompat: true,
    deployConfig: true,
    wrangler: {
      name: 'mcp-soubiran-dev',
      compatibility_flags: [
        'nodejs_compat_v2',
      ],
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
