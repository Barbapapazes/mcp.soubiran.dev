import { z } from 'zod'

export const toolNames = ['list_pages', 'search_content', 'get_page'] as const

export const caseSchema = z.object({
  id: z.string().regex(/^[\w-]+$/),
  prompt: z.string().min(1),
  rubric: z.string().min(1),
  requiredTools: z.array(z.enum(toolNames)).default([]),
  referenceAnswer: z.string().optional(),
})
export const casesSchema = z.array(caseSchema).min(1).superRefine((cases, ctx) => {
  if (new Set(cases.map(item => item.id)).size !== cases.length)
    ctx.addIssue({ code: 'custom', message: 'Case IDs must be unique.' })
})
export type EvalCase = z.infer<typeof caseSchema>

export interface ToolTrace {
  toolCallId: string
  toolName: string
  input: unknown
  output?: unknown
  error?: string
  durationMs: number
}

export interface Check {
  name: string
  passed: boolean
  detail: string
}

export const gradeKeys = ['grounded', 'fulfills_request', 'citations', 'case_rubric'] as const
const probability = z.number().min(0).max(1)
const noul = z.object({ type: z.literal('noul'), noul: probability })
export const judgeSchema = z.object({
  model: z.string(),
  answers: z.object({
    grounded: noul,
    fulfills_request: noul,
    citations: noul,
    case_rubric: noul,
  }),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
})
export type JudgeResult = z.infer<typeof judgeSchema>

export function toolFailed(trace: ToolTrace) {
  return !!trace.error || (typeof trace.output === 'object' && trace.output !== null && 'isError' in trace.output && trace.output.isError === true)
}

export function checkAnswer(test: EvalCase, answer: string, trace: ToolTrace[]): Check[] {
  return [
    { name: 'Non-empty answer', passed: answer.trim().length > 0, detail: 'The agent must produce a final answer.' },
    ...test.requiredTools.map(toolName => ({
      name: `Successful ${toolName} call`,
      passed: trace.some(call => call.toolName === toolName && !toolFailed(call)),
      detail: `At least one successful ${toolName} call is required by this case.`,
    })),
  ]
}

export type Outcome = 'pass' | 'review' | 'fail' | 'error'

export function outcome(checks: Check[], judge: JudgeResult | undefined, threshold: number, error?: string): Outcome {
  if (error || !judge)
    return 'error'
  if (checks.some(check => !check.passed))
    return 'fail'
  const scores = gradeKeys.map(key => judge.answers[key].noul)
  if (scores.some(score => score < 0.5))
    return 'fail'
  return scores.every(score => score >= threshold) ? 'pass' : 'review'
}

export interface CaseResult {
  test: EvalCase
  repetition: number
  answer: string
  trace: ToolTrace[]
  checks: Check[]
  judge?: JudgeResult
  error?: string
  errorStage?: 'agent' | 'judge'
  finishReason?: string
  usage?: unknown
  durationMs: number
  outcome: Outcome
}

export interface Report {
  startedAt: string
  config: {
    mcpUrl: string
    agentModel: string
    agentBaseUrl: string
    judgeModel: string
    threshold: number
    maxSteps: number
    repetitions: number
    systemPrompt: string
  }
  results: CaseResult[]
}

function block(text: string, language = '') {
  const fence = '~'.repeat(Math.max(4, ...Array.from(text.matchAll(/~+/g), match => match[0].length + 1)))
  return `${fence}${language}\n${text}\n${fence}`
}

export function renderReport(report: Report) {
  const counts = Object.fromEntries(['pass', 'review', 'fail', 'error'].map(status => [status, report.results.filter(result => result.outcome === status).length]))
  const lines = [
    '# MCP evaluation report',
    '',
    `Started: ${report.startedAt}`,
    `Agent: ${report.config.agentModel}; judge: ${report.config.judgeModel}`,
    `MCP: ${report.config.mcpUrl}`,
    `Pass: ${counts.pass} · Review: ${counts.review} · Fail: ${counts.fail} · Error: ${counts.error}`,
    '',
    'Judge values are estimated probabilities of meeting each criterion, not objective quality scores. Review failures and borderline results manually. Errors are infrastructure/grading failures, not quality scores.',
    '',
    '| Case | Run | Outcome | Grounded | Request | Citations | Rubric | Calls |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.results.map(result => `| ${result.test.id} | ${result.repetition} | ${result.outcome} | ${gradeKeys.map(key => result.judge ? result.judge.answers[key].noul.toFixed(2) : '—').join(' | ')} | ${result.trace.length} |`),
  ]
  for (const result of report.results) {
    lines.push('', `## ${result.test.id} — run ${result.repetition}: ${result.outcome}`, '',
      '### Prompt', block(result.test.prompt),
      '### Rubric', block(result.test.rubric),
      '### Answer', block(result.answer || '(No answer)'),
      '### Checks', ...result.checks.map(check => `- ${check.passed ? 'PASS' : 'FAIL'}: ${check.name}. ${check.detail}`),
      `- Tool errors (including recovered errors): ${result.trace.filter(toolFailed).length}`,
      `- Duration: ${(result.durationMs / 1000).toFixed(1)}s; finish reason: ${result.finishReason ?? 'unavailable'}`)
    if (result.error)
      lines.push(`### ${result.errorStage} error`, block(result.error))
    if (result.judge)
      lines.push('### Judge', block(JSON.stringify(result.judge, null, 2), 'json'))
    if (result.test.referenceAnswer)
      lines.push('### Reference answer', block(result.test.referenceAnswer))
    lines.push('### Tool trace', block(JSON.stringify(result.trace, null, 2), 'json'))
  }
  return `${lines.join('\n')}\n`
}
