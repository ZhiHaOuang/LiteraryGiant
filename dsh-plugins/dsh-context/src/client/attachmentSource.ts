import { previewAddressOf } from './fileActivity'
import type { AttachmentRef } from '../shared/attachment'
import { ATTACHMENT_ROUTE } from './apiRoutes'
import { asRecord, openResourceVia } from './services'
import type { AttachmentLocator, AttachmentOpener, ClientCtx } from './services'

const CACHE_MAX = 32

const paths = new Map<string, string>()

export function clearAttachmentPaths(): void {
  paths.clear()
}

export function pathOfValue(value: unknown): string | null {
  const data = asRecord(value)
  return data !== null && typeof data.path === 'string' && data.path !== '' ? data.path : null
}

export function makeAttachmentLocator(sessionId: string | undefined): AttachmentLocator | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  return async (attachment: AttachmentRef) => {
    const key = attachment.attachmentId
    const cached = paths.get(key)
    if (cached !== undefined) return cached
    try {
      const response = await fetch(ATTACHMENT_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, attachmentId: key }),
      })
      if (!response.ok) return null
      const body = asRecord(await response.json())
      if (body === null || body.ok !== true) return null
      const path = pathOfValue(body.value)
      if (path === null) return null
      if (paths.size >= CACHE_MAX) {
        const oldest = paths.keys().next().value
        /* v8 ignore next 1 */
        if (oldest !== undefined) paths.delete(oldest)
      }
      paths.set(key, path)
      return path
    } catch {
      return null
    }
  }
}

export function makeAttachmentOpener(
  ctx: ClientCtx,
  sessionId: string | undefined,
  workspace: string | undefined,
): AttachmentOpener | undefined {
  const locate = makeAttachmentLocator(sessionId)
  const openPreview = openResourceVia(ctx)
  if (locate === undefined || openPreview === undefined) return undefined
  return async (attachment: AttachmentRef) => {
    const path = await locate(attachment)
    if (path === null) return false
    const address = previewAddressOf(path, 'text', false, sessionId, workspace)
    return address !== undefined && openPreview(address)
  }
}
