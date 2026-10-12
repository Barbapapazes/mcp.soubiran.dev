import { executeSnapshotCode } from '../code-mode'

export function executeContentCode(loader: WorkerLoader, pages: readonly unknown[], code: string) {
  return executeSnapshotCode(loader, pages, code, 'pages')
}
