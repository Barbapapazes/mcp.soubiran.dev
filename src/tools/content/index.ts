import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerGetContentTool } from './get'
import { registerListContentTool } from './list'
import { registerSearchContentTool } from './search'

export function registerContentTools(server: McpServer, env: Env) {
  registerListContentTool(server, env)
  registerGetContentTool(server, env)
  registerSearchContentTool(server, env)
}
