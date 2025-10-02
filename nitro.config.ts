import { defineNitroConfig } from 'nitropack/config'

export default defineNitroConfig({
  runtimeConfig: {
    baseMcpUrl: 'https://soubiran.dev/api/mcp',
  },

  compatibilityDate: 'latest',
  srcDir: 'server',
})
