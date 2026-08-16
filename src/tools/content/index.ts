import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { talksAdapter, talkTopics } from './adapters/talks'
import { registerGetContentTool } from './get'
import { registerListContentTool } from './list'
import { registerSearchContentTool } from './search'

const topicsByCatalogUrl = new Map<string, Promise<readonly string[]>>()

function getTalkTopics(env: Env) {
  let topics = topicsByCatalogUrl.get(env.TALKS_BASE_URL)
  if (!topics) {
    topics = talksAdapter.load(env.TALKS_BASE_URL).then(talkTopics)
    topicsByCatalogUrl.set(env.TALKS_BASE_URL, topics)
  }
  return topics
}

export async function registerContentTools(server: McpServer, env: Env) {
  const topics = await getTalkTopics(env)
  registerListContentTool(server, env, topics)
  registerGetContentTool(server, env)
  registerSearchContentTool(server, env)
}
