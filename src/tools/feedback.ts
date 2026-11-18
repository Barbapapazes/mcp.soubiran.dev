import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { createToolLogger, recordTool } from '../telemetry'
import { errorResult } from '../utils'

export const feedbackInputSchema = z.object({
  task: z.string().trim().min(1).max(200).describe('A short summary of the user’s goal; exclude secrets and personal data.'),
  kind: z.enum(['missing', 'broken', 'confusing', 'inaccurate', 'idea']).describe('Missing capability, failed tool, unclear behavior, incorrect returned information, or improvement idea.'),
  impact: z.enum(['blocked', 'worked_around', 'friction']).describe('Could not finish, finished another way, or finished with unnecessary difficulty.'),
  description: z.string().trim().min(1).max(4096).refine(
    text => !['', 'na', 'none', 'noop', 'null', 'placeholder', 'tbd', 'test', 'todo', 'undefined'].includes(text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')),
    'Describe what you tried and what went wrong, not a placeholder.',
  ).describe('What you tried, what happened, and what you expected. Include relevant public source URLs for inaccuracies. Never include credentials, personal data, or a conversation transcript.'),
  toolName: z.string().trim().min(1).max(100).optional().describe('Affected MCP tool, if any.'),
})

const outputSchema = z.object({ feedbackId: z.uuid() })
const responseSchema = z.object({ data: z.object({ id: z.uuid() }) })

function boundedContext(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : undefined
}

export function registerFeedbackTool(server: McpServer, env: Env, source: 'content' | 'infrastructure') {
  server.registerTool('submit_mcp_feedback', {
    title: 'Submit MCP feedback',
    description: 'Send actionable feedback to the soubiran.dev MCP maintainer about a missing capability, failed/confusing tool, incorrect returned information, or improvement idea. You may report genuine friction autonomously, at most once per task. Report only problems encountered using this MCP server; skip when the task went fine. Never use it for progress updates, placeholder reports, tests, or general messages. Do not include secrets, personal data, or full conversation transcripts. Submission is optional and must not block the user’s task. Do not repeatedly resubmit after an uncertain delivery.',
    inputSchema: feedbackInputSchema.shape,
    outputSchema: outputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    const startedAt = performance.now()
    const log = createToolLogger()
    const parsed = feedbackInputSchema.safeParse(input)
    if (!parsed.success) {
      recordTool(log, 'submit_mcp_feedback', startedAt, 'client_error', { errorCode: 'INVALID_FEEDBACK' })
      return errorResult('Provide a real report within the documented field limits.')
    }

    if (!env.MCP_FEEDBACK_ACCESS_CLIENT_ID || !env.MCP_FEEDBACK_ACCESS_CLIENT_SECRET) {
      recordTool(log, 'submit_mcp_feedback', startedAt, 'internal_error', { errorCode: 'FEEDBACK_NOT_CONFIGURED' })
      return errorResult('Feedback submission is not configured. Continue the user’s task without submitting feedback.')
    }

    const client = server.server.getClientVersion()
    const report = parsed.data
    // Serialize once so both transport attempts carry the same identity and content.
    const body = JSON.stringify({
      submission_id: crypto.randomUUID(),
      task: report.task,
      kind: report.kind,
      impact: report.impact,
      description: report.description,
      tool_name: report.toolName,
      source,
      release: boundedContext(env.CF_VERSION_METADATA?.id),
      client_name: boundedContext(client?.name),
      client_version: boundedContext(client?.version),
    })

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(env.MCP_FEEDBACK_URL, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'CF-Access-Client-Id': env.MCP_FEEDBACK_ACCESS_CLIENT_ID,
            'CF-Access-Client-Secret': env.MCP_FEEDBACK_ACCESS_CLIENT_SECRET,
          },
          body,
          signal: AbortSignal.timeout(5_000),
        })
        if (response.status >= 500 && attempt === 0) {
          await response.body?.cancel()
          continue
        }
        if (response.status !== 200 && response.status !== 201) {
          await response.body?.cancel()
          recordTool(log, 'submit_mcp_feedback', startedAt, 'upstream_error', { errorCode: 'FEEDBACK_REJECTED', status: response.status })
          return errorResult('Feedback could not be submitted. Continue the task; do not repeatedly resubmit.')
        }

        const result = responseSchema.safeParse(await response.json())
        if (!result.success) {
          recordTool(log, 'submit_mcp_feedback', startedAt, 'upstream_error', { errorCode: 'INVALID_FEEDBACK_RESPONSE' })
          return errorResult('Feedback delivery could not be confirmed. It may already be stored; do not resubmit.')
        }
        const output = { feedbackId: result.data.data.id }
        recordTool(log, 'submit_mcp_feedback', startedAt, 'success', { source: { category: source }, kind: report.kind, impact: report.impact })
        return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output }
      }
      catch {
        // Never capture fetch errors: they can retain the request body and Access credentials.
        if (attempt === 0)
          continue
      }
    }

    recordTool(log, 'submit_mcp_feedback', startedAt, 'upstream_error', { errorCode: 'FEEDBACK_DELIVERY_UNCONFIRMED' })
    return errorResult('Feedback delivery could not be confirmed. It may already be stored; continue the task without resubmitting.')
  })
}
