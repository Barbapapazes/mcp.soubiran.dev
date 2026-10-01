export function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Unexpected error.'
}

export class ContentCodeExecutionError extends Error {
  override name = 'ContentCodeExecutionError'

  constructor({ cause, message = errorMessage(cause) }: { cause: unknown, message?: string }) {
    super(message, { cause })
  }
}

export class ContentCodeExecutorError extends Error {
  override name = 'ContentCodeExecutorError'

  constructor({ cause }: { cause: unknown }) {
    super(errorMessage(cause), { cause })
  }
}
