interface ErrorContext {
  name?: string
  message: string
  httpStatus?: number
  url?: string
  cause?: ErrorContext
}

const MAX_TEXT_LENGTH = 512
const MAX_CAUSE_DEPTH = 4

function readProperty(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key)
  }
  catch {
    return undefined
  }
}

function safeUrl(value: string) {
  try {
    const url = new URL(value)
    // Never log credentials, query parameters, or fragments from upstream URLs.
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, MAX_TEXT_LENGTH)
  }
  catch {
    return '[invalid URL]'
  }
}

function safeText(value: string) {
  return value.replace(/https?:\/\/[^\s"'<>]+/g, safeUrl).slice(0, MAX_TEXT_LENGTH)
}

/** Log only bounded primitive fields, never error payloads, stacks, or arbitrary objects. */
export function shapeError(error: unknown): ErrorContext {
  const seen = new Set<object>()

  function visit(value: unknown, depth: number): ErrorContext {
    if (typeof value !== 'object' || value === null)
      return { message: typeof value === 'string' ? safeText(value) : 'Unexpected error.' }
    if (seen.has(value))
      return { message: 'Circular error cause.' }
    if (depth >= MAX_CAUSE_DEPTH)
      return { message: 'Error cause depth limit reached.' }
    seen.add(value)

    const message = readProperty(value, 'message')
    const name = readProperty(value, 'name')
    const status = readProperty(value, 'statusCode') ?? readProperty(value, 'status')
    const url = readProperty(value, 'url')
    const cause = readProperty(value, 'cause')

    return {
      message: typeof message === 'string' ? safeText(message) : 'Unexpected error.',
      ...(typeof name === 'string' ? { name: safeText(name) } : {}),
      ...(typeof status === 'number' && Number.isFinite(status) ? { httpStatus: status } : {}),
      ...(typeof url === 'string' ? { url: safeUrl(url) } : {}),
      ...(cause !== undefined ? { cause: visit(cause, depth + 1) } : {}),
    }
  }

  return visit(error, 0)
}
