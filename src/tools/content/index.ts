import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerGetPageTool } from './get'
import { registerListPagesTool } from './list'
import { registerSearchContentTool } from './search'

export function registerContentTools(server: McpServer, env: Env) {
  registerListPagesTool(server, env)
  registerGetPageTool(server, env)
  registerSearchContentTool(server, env)
}
