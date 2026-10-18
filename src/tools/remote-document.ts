import type { z } from 'zod'
import { FetchError, ofetch } from 'ofetch'

export const REMOTE_DOCUMENT_TIMEOUT_MS = 10_000

type FailureKind = 'http' | 'timeout' | 'network' | 'json' | 'schema'

function diagnosticUrl(value: string) {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname}`
  }
  catch {
    return '[invalid URL]'
  }
}

export class RemoteDocumentError extends Error {
  override name = 'RemoteDocumentError'
  readonly url: string

  constructor(
    readonly kind: FailureKind,
    label: string,
    url: string,
    cause: unknown,
    readonly status?: number,
  ) {
    const details: Record<FailureKind, string> = {
      http: `failed with HTTP ${status}`,
      timeout: `timed out after ${REMOTE_DOCUMENT_TIMEOUT_MS}ms`,
      network: 'failed before a response could be read',
      json: 'returned invalid JSON',
      schema: 'returned a payload that does not match the expected schema',
    }
    const safeUrl = diagnosticUrl(url)
    super(`The ${label} request to ${safeUrl} ${details[kind]}.`, { cause })
    this.url = safeUrl
  }
}

/** One attempt and one deadline, including response-body reading; never cache failures. */
export async function loadRemoteText(url: string, label: string, accept: string): Promise<string> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const cause = new Error('Remote document deadline exceeded')
      // Settle the deadline even when a producer/runtime ignores the abort signal.
      reject(new RemoteDocumentError('timeout', label, url, cause))
      controller.abort(cause)
    }, REMOTE_DOCUMENT_TIMEOUT_MS)
  })

  try {
    return await Promise.race([
      ofetch<string>(url, { headers: { Accept: accept }, responseType: 'text', signal: controller.signal, retry: 0 }),
      deadline,
    ])
  }
  catch (cause) {
    if (cause instanceof RemoteDocumentError)
      throw cause
    const status = cause instanceof FetchError ? cause.status : undefined
    throw new RemoteDocumentError(typeof status === 'number' ? 'http' : 'network', label, url, cause, status)
  }
  finally {
    clearTimeout(timer)
  }
}

export async function loadRemoteJson<T>(url: string, label: string, schema: z.ZodType<T>): Promise<T> {
  const text = await loadRemoteText(url, label, 'application/json')
  let payload: unknown
  try {
    payload = JSON.parse(text)
  }
  catch (cause) {
    throw new RemoteDocumentError('json', label, url, cause)
  }

  try {
    return schema.parse(payload)
  }
  catch (cause) {
    // Preserve the validation cause for Sentry, without putting source data in the message.
    throw new RemoteDocumentError('schema', label, url, cause)
  }
}
