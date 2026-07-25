/* eslint-disable unicorn/throw-new-error */
import { TaggedError } from 'better-result'

function getCauseMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Unexpected error.'
}

export class PageDirectoryError extends TaggedError('PageDirectoryError')<{
  cause: unknown
  message: string
}>() {
  constructor({ cause, message = getCauseMessage(cause) }: { cause: unknown, message?: string }) {
    super({ cause, message })
  }
}

export class PageNotFoundError extends TaggedError('PageNotFoundError')<{
  identifier: string
  message: string
}>() {
  constructor({ identifier }: { identifier: string }) {
    super({
      identifier,
      message: `No English page matches "${identifier}". Provide its exact title, canonical URI, or metadata ID. Use search_pages without a query to list available pages.`,
    })
  }
}

export class PageRetrievalError extends TaggedError('PageRetrievalError')<{
  cause: unknown
  message: string
}>() {
  constructor({ cause }: { cause: unknown }) {
    super({ cause, message: getCauseMessage(cause) })
  }
}

export class PageSearchError extends TaggedError('PageSearchError')<{
  cause: unknown
  message: string
}>() {
  constructor({ cause }: { cause: unknown }) {
    super({ cause, message: getCauseMessage(cause) })
  }
}

export class PageSourceNotFoundError extends TaggedError('PageSourceNotFoundError')<{
  source: string
  message: string
}>() {
  constructor({ source }: { source: string }) {
    super({ source, message: 'The search result does not correspond to an English page.' })
  }
}
