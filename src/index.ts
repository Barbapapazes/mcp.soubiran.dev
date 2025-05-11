import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { ofetch } from 'ofetch'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

const server = new Server(
  {
    name: 'mcp.soubiran.dev',
    version: '0.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
)

const GetNextId = z.object({})

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'next_post_id',
        description: 'Get the next post ID for a post on soubiran.dev',
        inputSchema: zodToJsonSchema(GetNextId),
      },
    ],
  }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'next_post_id') {
    try {
      const data = await ofetch<{ next_post_id: number }>('http://localhost:8000/api/posts/next-id')

      return {
        content: [{
          type: 'text',
          text: data.next_post_id,
        }],
      }
    }
    catch (error) {
      throw new Error(`Error fetching next post ID: ${error}`)
    }
  }

  throw new Error('Unknown tool')
})

const transport = new StdioServerTransport()
// eslint-disable-next-line antfu/no-top-level-await
await server.connect(transport)
