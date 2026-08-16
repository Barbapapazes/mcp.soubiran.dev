import type { ContentCategory } from '../types'
import { infraAdapter } from './infra'
import { pagesAdapter } from './pages'
import { talksAdapter } from './talks'

export { infraAdapter } from './infra'
export { pagesAdapter } from './pages'
export { talksAdapter } from './talks'

export const contentAdapters = {
  pages: pagesAdapter,
  talks: talksAdapter,
  infra: infraAdapter,
} as const

export const categoriesByInstanceId = new Map<string, ContentCategory>(
  Object.values(contentAdapters).map(adapter => [adapter.instanceId, adapter.category]),
)

export function directoryUrl(env: Env, category: ContentCategory) {
  switch (category) {
    case 'pages': return env.PAGES_BASE_URL
    case 'talks': return env.TALKS_BASE_URL
    case 'infra': return env.INFRA_BASE_URL
  }
}

export async function loadContentDirectories(env: Env) {
  const [pages, talks, infra] = await Promise.all([
    pagesAdapter.load(env.PAGES_BASE_URL),
    talksAdapter.load(env.TALKS_BASE_URL),
    infraAdapter.load(env.INFRA_BASE_URL),
  ])

  return { pages, talks, infra }
}
