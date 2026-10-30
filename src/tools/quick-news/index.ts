import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerGetQuickNewsTool } from './get'
import { registerListQuickNewsTool } from './list'
import { registerSearchQuickNewsTool } from './search'

export function registerQuickNewsTools(server: McpServer, env: Env) {
  registerListQuickNewsTool(server, env)
  registerGetQuickNewsTool(server, env)
  registerSearchQuickNewsTool(server, env)
}
