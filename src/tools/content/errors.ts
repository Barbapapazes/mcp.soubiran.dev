/* eslint-disable unicorn/throw-new-error */
import { TaggedError } from 'better-result'

function causeMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Unexpected error.'
}

export class ContentDirectoryError extends TaggedError('ContentDirectoryError')<{
  category: string
  cause: unknown
  message: string
}>() {
  constructor({ category, cause, message = causeMessage(cause) }: { category: string, cause: unknown, message?: string }) {
    super({ category, cause, message })
  }
}

export class ContentNotFoundError extends TaggedError('ContentNotFoundError')<{
  id: string
  message: string
}>() {
  constructor({ id }: { id: string }) {
    super({ id, message: `No content matches "${id}". Use search_content or list_content to find an exact ID.` })
  }
}

export class ContentUnavailableError extends TaggedError('ContentUnavailableError')<{
  message: string
}>() {
  constructor({ message }: { message: string }) {
    super({ message })
  }
}

export class ContentRetrievalError extends TaggedError('ContentRetrievalError')<{
  category: string
  cause: unknown
  message: string
}>() {
  constructor({ category, cause }: { category: string, cause: unknown }) {
    super({ category, cause, message: causeMessage(cause) })
  }
}

export class ContentSearchError extends TaggedError('ContentSearchError')<{
  cause: unknown
  message: string
}>() {
  constructor({ cause }: { cause: unknown }) {
    super({ cause, message: causeMessage(cause) })
  }
}

export class ContentDirectoryContractError extends TaggedError('ContentDirectoryContractError')<{
  message: string
}>() {
  constructor({ message }: { message: string }) {
    super({ message })
  }
}

export class ContentCodeExecutionError extends TaggedError('ContentCodeExecutionError')<{
  cause: unknown
  message: string
}>() {
  constructor({ cause, message = causeMessage(cause) }: { cause: unknown, message?: string }) {
    super({ cause, message })
  }
}

export class ContentCodeExecutorError extends TaggedError('ContentCodeExecutorError')<{
  cause: unknown
  message: string
}>() {
  constructor({ cause }: { cause: unknown }) {
    super({ cause, message: causeMessage(cause) })
  }
}
