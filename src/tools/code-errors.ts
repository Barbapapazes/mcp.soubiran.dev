export function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Unexpected error.'
}

export class CodeExecutionError extends Error {
  override name = 'CodeExecutionError'

  constructor({ cause, message = errorMessage(cause) }: { cause: unknown, message?: string }) {
    super(message, { cause })
  }
}

export class CodeExecutorError extends Error {
  override name = 'CodeExecutorError'

  constructor({ cause }: { cause: unknown }) {
    super(errorMessage(cause), { cause })
  }
}
