export const SITE_URL = 'https://soubiran.dev'

export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

export function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}
