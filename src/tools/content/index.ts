import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Principal } from '../../auth'
import { registerGetPageTool } from './get'
import { registerListPagesTool } from './list'
import { registerSearchContentTool } from './search'

export function registerContentTools(server: McpServer, env: Env, principal: Principal) {
  registerListPagesTool(server, env, principal)
  registerGetPageTool(server, env, principal)
  registerSearchContentTool(server, env, principal)
}
