import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpAgent } from 'agents/mcp'
import { env } from 'cloudflare:workers'
import { ofetch } from 'ofetch'
import { z } from 'zod'

export class SoubiranMcp extends McpAgent {
  server = new McpServer({
    name: 'Estéban Soubiran personal website (soubiran.dev)',
    version: '1.0.0',
  })

  async init() {
    this.server.tool(
      'list_languages',
      'Returns a machine-readable JSON array of all supported languages for Estéban\'s website. Each object includes a "code" (ISO 639-1) and "name" (English name). Example response: [{"code":"en","name":"English"},{"code":"fr","name":"French"}].',
      {},
      async () => {
        const result = await ofetch('languages.json', {
          baseURL: env.BASE_API_URL,
        })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        }
      },
    )

    this.server.tool(
      'list_parts',
      'Returns a machine-readable JSON array of all available parts (sections) of Estéban\'s website. Each object includes an "id" (string), "name" (string), and "description" (string). Example response: [{"id":"pages","name":"Pages","description":"All website pages available."},{"id":"blog","name":"Blog","description":"All blog posts available."}].',
      {},
      async () => {
        const result = await ofetch('parts.json', {
          baseURL: env.BASE_API_URL,
        })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        }
      },
    )

    this.server.tool(
      'list_pages',
      'Returns a list of all available pages on Estéban\'s website for a specified language. Each page includes its title, description, URL, and date. Use the "language" parameter to select the language (e.g., "en" for English, "fr" for French). The response is a JSON array of objects: [{ "title": string, "description": string, "url": string, "uri": string, "date": string }].',
      {
        language: z.string().min(2).max(2).describe('Language code for the content pages (e.g., "en", "fr")'),
      },
      async ({ language }) => {
        const result = await ofetch(`pages.${language}.json`, {
          baseURL: env.BASE_API_URL,
        })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        }
      },
    )

    this.server.tool(
      'list_posts',
      'Returns a list of all available blog posts on Estéban\'s website for a specified language. Each post includes its title, description, URL and date. Use the "language" parameter to select the language (e.g., "en" for English, "fr" for French). The response is a JSON array of objects: [{ "title": string, "description": string, "url": string, "uri": string, "date": string }].',
      {
        language: z.string().min(2).max(2).describe('Language code for the blog posts (e.g., "en", "fr")'),
      },
      async ({ language }) => {
        const result = await ofetch(`posts.${language}.json`, {
          baseURL: env.BASE_API_URL,
        })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        }
      },
    )

    this.server.tool(
      'list_series',
      'Returns a list of all available series on Estéban\'s website for a specified language. Each series includes its title, description, URL, and date. Use the "language" parameter to select the language (e.g., "en" for English, "fr" for French). The response is a JSON array of objects: [{ "title": string, "description": string, "url": string, "uri": string, "date": string }].',
      {
        language: z.string().min(2).max(2).describe('Language code for the series (e.g., "en", "fr")'),
      },
      async ({ language }) => {
        const result = await ofetch(`series.${language}.json`, {
          baseURL: env.BASE_API_URL,
        })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        }
      },
    )

    this.server.tool(
      'list_series_articles',
      'Returns a list of all articles within a specified series on Estéban\'s website for a given language. Each article includes its title, description, URL, and date. Use the "language" parameter to select the language (e.g., "en" for English, "fr" for French) and the "series" parameter to specify the series URI. The response is a JSON array of objects: [{ "title": string, "description": string, "url": string, "uri": string, "date": string }].',
      {
        language: z.string().min(2).max(2).describe('Language code for the articles (e.g., "en", "fr")'),
        series: z.string().min(2).max(100).describe('URI of the series to retrieve articles from'),
      },
      async ({ language, series }) => {
        if (language === 'fr') {
          series = series.slice(4)
        }
        else {
          series = series.slice(1)
        }

        const result = await ofetch(`${series.replace(/\//g, '-')}.${language}.json`, {
          baseURL: env.BASE_API_URL,
        })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        }
      },
    )

    this.server.tool(
      'list_projects',
      `Returns a machine-readable JSON array of all project categories for Estéban, each with a "title" (category name) and a "projects" array.
Each project includes:
- "name" (string, e.g. "barbapapazes/code.soubiran.dev"),
- "description" (string),
- "stars" (number),
- "updatedAt" (ISO 8601 string),
- "topics" (array of strings),
- "url" (string),
- "license" (string, optional).

Example response:
[
  {
    "title": "Ecosystem",
    "projects": [
      {
        "name": "barbapapazes/code.soubiran.dev",
        "description": "Create beautiful images from code.",
        "stars": 3,
        "updatedAt": "2025-03-16T21:16:15Z",
        "topics": ["code", "vue"],
        "url": "https://github.com/Barbapapazes/code.soubiran.dev"
      }
    ]
  }
]
`,
      {},
      async () => {
        const result = await ofetch('projects.json', {
          baseURL: env.BASE_API_URL,
        })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        }
      },
    )

    this.server.tool(
      'list_talks',
      `Returns a machine-readable JSON array of all talks given by Estéban Soubiran.
Each talk includes:
- "name" (title of the talk, string)
- "event" (event name, string)
- "date" (ISO 8601 date, string)
- "url" (main talk URL, string)
- "pdf_url" (slides PDF URL, string, optional)
- "thumbnail_url" (thumbnail image URL, string, optional)
- "github_url" (GitHub repo URL, string, optional)
- "recording_url" (video recording URL, string, optional)

Example response:
[
  {
    "name": "Unpoly pour reprendre le contrôle !",
    "event": "Devoxx France",
    "date": "2023-04-12",
    "url": "https://talks.soubiran.dev/2023-04-12/devoxxfr",
    "pdf_url": "https://talks.soubiran.dev/2023-04-12/devoxxfr/pdf",
    "thumbnail_url": "https://talks.soubiran.dev/2023-04-12/devoxxfr/thumbnail.png",
    "github_url": "https://github.com/Barbapapazes/talks/tree/main/2023-04-12",
    "recording_url": "https://talks.soubiran.dev/2023-04-12/devoxxfr/recording"
  }
]
`,
      {},
      async () => {
        const result = await ofetch('talks.json', {
          baseURL: env.BASE_API_URL,
        })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        }
      },
    )

    this.server.tool(
      'list_socials',
      `Returns a machine-readable JSON array of all social media profiles for Estéban Soubiran.
Each profile includes:
- "name" (platform name, string, e.g. "Twitter")
- "url" (profile URL, string)

Example response:
[
  { "name": "Twitter", "url": "https://twitter.com/estebansoubiran" },
  { "name": "GitHub", "url": "https://github.com/Barbapapazes" }
]
`,
      {},
      async () => {
        const result = await ofetch('socials.json', {
          baseURL: env.BASE_API_URL,
        })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        }
      },
    )

    this.server.tool(
      'get_page',
      'Fetches a specific page from Estéban\'s website. The response is the MarkDown content of the page.',
      {
        url: z.string().min(1).describe('URL to the page to retrieve (e.g., "/about", "/contact")'),
      },
      async ({ url }) => {
        if (url === '/') {
          url = '/index'
        }

        if (url === '/fr/') {
          url = '/fr/index'
        }

        const result = await ofetch(`pages${url}.md`, {
          baseURL: env.BASE_API_URL,
        })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        }
      },
    )
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url)

    if (url.pathname === '/sse' || url.pathname === '/sse/message') {
      return SoubiranMcp.serveSSE('/sse').fetch(request, env, ctx)
    }

    if (url.pathname === '/mcp') {
      return SoubiranMcp.serve('/mcp').fetch(request, env, ctx)
    }

    return Response.redirect('https://soubiran.dev', 302)
  },
}
