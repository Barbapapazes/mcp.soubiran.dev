import { parse } from 'acorn'
import { CodeExecutionError, CodeExecutorError } from './code-errors'

const MAX_RESULT_BYTES = 256 * 1024

interface SnapshotCodeExecutorEntrypoint {
  evaluate: () => Promise<{ error?: string, resultJson?: string }>
}

function validateCode(code: string) {
  let program
  try {
    program = parse(code, { ecmaVersion: 'latest', sourceType: 'script' })
  }
  catch (cause) {
    throw new CodeExecutionError({ cause, message: 'Code must be a valid async JavaScript arrow function.' })
  }

  const statement = program.body[0]
  if (program.body.length !== 1 || statement?.type !== 'ExpressionStatement' || statement.expression.type !== 'ArrowFunctionExpression' || !statement.expression.async) {
    throw new CodeExecutionError({ cause: new Error('Code must be a single async JavaScript arrow function.') })
  }
}

function createWorkerCode(data: unknown, code: string, binding: 'pages' | 'topology') {
  return `
import { WorkerEntrypoint } from 'cloudflare:workers'

const NETWORK_DISABLED_MESSAGE = 'Network access is not available in code mode.'
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

const ${binding} = deepFreeze(${JSON.stringify(data)})
const submittedFunction = (
${code}
)

export default class SnapshotCodeExecutor extends WorkerEntrypoint {
  async evaluate() {
    try {
      const result = await submittedFunction()
      const resultJson = JSON.stringify(result)
      if (typeof resultJson !== 'string')
        throw new Error('Code must return a JSON-serializable value.')

      if (new TextEncoder().encode(resultJson).byteLength > ${MAX_RESULT_BYTES})
        throw new Error('The code result exceeds the 256 KiB response limit. Return a smaller result.')

      return { resultJson }
    }
    catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
}
`
}

export async function executeSnapshotCode(loader: WorkerLoader, data: unknown, code: string, binding: 'pages' | 'topology') {
  validateCode(code)

  try {
    const worker = loader.get(`${binding}-${crypto.randomUUID()}`, () => ({
      compatibilityDate: '2026-03-27',
      globalOutbound: null,
      limits: { cpuMs: 50, subRequests: 0 },
      mainModule: 'worker.js',
      modules: { 'worker.js': createWorkerCode(data, code, binding) },
    }))
    const entrypoint = worker.getEntrypoint() as unknown as SnapshotCodeExecutorEntrypoint
    let timer: ReturnType<typeof setTimeout> | undefined
    const response = await Promise.race([
      entrypoint.evaluate(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CodeExecutionError({
          cause: new Error('Execution timed out.'),
          message: 'Code execution exceeded the 5 second time limit.',
        })), 5_000)
      }),
    ]).finally(() => clearTimeout(timer))

    if (response.error) {
      throw new CodeExecutionError({ cause: new Error(response.error), message: `Code execution failed: ${response.error}` })
    }

    if (typeof response.resultJson !== 'string') {
      throw new CodeExecutionError({ cause: new Error('The executor did not return JSON.'), message: 'Code must return a JSON-serializable value.' })
    }

    if (new TextEncoder().encode(response.resultJson).byteLength > MAX_RESULT_BYTES) {
      throw new CodeExecutionError({
        cause: new Error(`The code result exceeds ${MAX_RESULT_BYTES} bytes.`),
        message: 'The code result exceeds the 256 KiB response limit. Return a smaller result.',
      })
    }

    return response.resultJson
  }
  catch (cause) {
    if (cause instanceof CodeExecutionError)
      throw cause

    throw new CodeExecutorError({ cause })
  }
}
