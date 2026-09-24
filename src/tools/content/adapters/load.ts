import type { z } from 'zod'
import type { ContentCategory } from '../types'
import { FetchError, ofetch } from 'ofetch'
import { ContentDirectoryError } from '../errors'

/**
 * Bounds every content-directory request so a producer that hangs is reported as a timeout
 * instead of holding the MCP request open until the platform ends it.
 */
export const CONTENT_DIRECTORY_TIMEOUT_MS = 5_000

/** ofetch aborts a timed-out request with an error named `TimeoutError`, nested under the `FetchError` it throws. */
function isTimeout(cause: FetchError) {
  const reason = (cause as { cause?: unknown }).cause

  return (reason instanceof Error && reason.name === 'TimeoutError') || cause.message.includes('TimeoutError')
}

function requestFailureMessage(category: ContentCategory, url: string, cause: unknown) {
  if (cause instanceof FetchError) {
    if (typeof cause.status === 'number')
      return `The ${category} directory request to ${url} failed with HTTP ${cause.status}${cause.statusText ? ` (${cause.statusText})` : ''}.`

    if (isTimeout(cause))
      return `The ${category} directory request to ${url} timed out after ${CONTENT_DIRECTORY_TIMEOUT_MS}ms.`

    return `The ${category} directory request to ${url} failed before receiving a response: ${cause.message}`
  }

  return `The ${category} directory request to ${url} failed: ${cause instanceof Error ? cause.message : 'Unexpected error.'}`
}

function contractFailureMessage(category: ContentCategory, url: string, error: z.ZodError) {
  const issues = error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || '<root>'} (${issue.message})`).join('; ')
  const omitted = error.issues.length > 5 ? ` and ${error.issues.length - 5} more` : ''

  return `The ${category} directory request to ${url} succeeded but the payload does not match the expected catalog schema: ${issues}${omitted}.`
}

export async function loadDirectory<Catalog>(category: ContentCategory, url: string, schema: z.ZodType<Catalog>): Promise<Catalog> {
  let payload: unknown
  try {
    payload = await ofetch(url, { headers: { Accept: 'application/json' }, timeout: CONTENT_DIRECTORY_TIMEOUT_MS })
  }
  catch (cause) {
    throw new ContentDirectoryError({ category, cause, message: requestFailureMessage(category, url, cause) })
  }

  const parsed = schema.safeParse(payload)
  if (!parsed.success)
    throw new ContentDirectoryError({ category, cause: parsed.error, message: contractFailureMessage(category, url, parsed.error) })

  return parsed.data
}
