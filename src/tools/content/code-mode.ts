import { parse } from 'acorn'
import { ContentCodeExecutionError, ContentCodeExecutorError } from './errors'

const MAX_RESULT_BYTES = 256 * 1024

interface ContentCodeExecutorEntrypoint {
  evaluate: () => Promise<{ error?: string, resultJson?: string }>
}

interface ContentDirectories {
  pages: unknown
  talks: unknown
  infra: unknown
}

function validateCode(code: string) {
  try {
    const program = parse(code, { ecmaVersion: 'latest', sourceType: 'script' })
    const statement = program.body[0]
    if (program.body.length !== 1 || statement?.type !== 'ExpressionStatement' || statement.expression.type !== 'ArrowFunctionExpression' || !statement.expression.async) {
      throw new Error('Code must be a single async JavaScript arrow function.')
    }
  }
  catch (cause) {
    throw new ContentCodeExecutionError({
      cause,
      message: cause instanceof Error && cause.message === 'Code must be a single async JavaScript arrow function.'
        ? cause.message
        : 'Code must be a valid async JavaScript arrow function.',
    })
  }
}

function createWorkerCode(directories: ContentDirectories, code: string) {
  return `
import { WorkerEntrypoint } from 'cloudflare:workers'

const NETWORK_DISABLED_MESSAGE = 'Network access is not available in list_content code mode.'
const denyNetwork = () => { throw new Error(NETWORK_DISABLED_MESSAGE) }

for (const name of ['fetch', 'WebSocket', 'EventSource']) {
  try {
    Object.defineProperty(globalThis, name, {
      configurable: false,
      enumerable: false,
      value: denyNetwork,
      writable: false,
    })
  }
  catch {
    // globalOutbound is null, so network remains unavailable.
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value))
    return value

  for (const child of Object.values(value))
    deepFreeze(child)

  return Object.freeze(value)
}

const pages = deepFreeze(${JSON.stringify(directories.pages)})
const talks = deepFreeze(${JSON.stringify(directories.talks)})
const infra = deepFreeze(${JSON.stringify(directories.infra)})
const submittedFunction = (
${code}
)

export default class ContentCodeExecutor extends WorkerEntrypoint {
  async evaluate() {
    try {
      const result = await submittedFunction()
      const resultJson = JSON.stringify(result)
      if (typeof resultJson !== 'string')
        throw new Error('Code must return a JSON-serializable value.')

      return { resultJson }
    }
    catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
}
`
}

export async function executeContentCode(loader: WorkerLoader, directories: ContentDirectories, code: string) {
  validateCode(code)

  try {
    const worker = loader.get(`content-list-${crypto.randomUUID()}`, () => ({
      compatibilityDate: '2026-03-27',
      globalOutbound: null,
      limits: { cpuMs: 50, subRequests: 0 },
      mainModule: 'worker.js',
      modules: { 'worker.js': createWorkerCode(directories, code) },
    }))
    const entrypoint = worker.getEntrypoint() as unknown as ContentCodeExecutorEntrypoint
    const response = await entrypoint.evaluate()

    if (response.error) {
      throw new ContentCodeExecutionError({ cause: new Error(response.error), message: `Code execution failed: ${response.error}` })
    }

    if (typeof response.resultJson !== 'string') {
      throw new ContentCodeExecutionError({ cause: new Error('The executor did not return JSON.'), message: 'Code must return a JSON-serializable value.' })
    }

    if (new TextEncoder().encode(response.resultJson).byteLength > MAX_RESULT_BYTES) {
      throw new ContentCodeExecutionError({
        cause: new Error(`The code result exceeds ${MAX_RESULT_BYTES} bytes.`),
        message: 'The code result exceeds the 256 KiB response limit. Return a smaller result.',
      })
    }

    return response.resultJson
  }
  catch (cause) {
    if (ContentCodeExecutionError.is(cause))
      throw cause

    throw new ContentCodeExecutorError({ cause })
  }
}
