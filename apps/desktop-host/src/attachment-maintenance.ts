/**
 * Desktop-side attachment maintenance: once a day, reclaim the content-addressed
 * attachment objects no retained Session log names any more.
 *
 * The reference set is built by reading every stored Session log — including the
 * ones parked in the Session store's recycle bin — and collecting every
 * `sha256:<hex>` digest they mention. Any read failure abandons the whole run:
 * deleting on a partial reference set would destroy attachments a Session still
 * needs, and a skipped day costs nothing but bytes.
 *
 * The run is bounded and background: it waits for the Host to be ready, holds a
 * one-day marker under the Harness home, and never rejects into the startup
 * path.
 * @module dsh-desktop-host/attachment-maintenance
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { sweepUnreferencedObjects, type AttachmentSweepResult } from '@deepseek-ai/dsh-attachment-local'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { dshCachePath } from '@deepseek-ai/dsh-home-paths'

/** Marker file recording the last completed sweep. */
const MARKER_NAME = 'attachment-gc.json'

/** How long an object must be untouched before the sweep may collect it. */
export const ATTACHMENT_PROTECT_MS = 24 * 60 * 60 * 1000

/** How long one completed sweep is trusted. */
export const ATTACHMENT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Every digest a body of text names, as the sweep compares them. */
export function digestsIn(text: string): string[] {
  return [...text.matchAll(/sha256:([0-9a-f]{64})/gu)].map(match => match[1] as string)
}

/** One stored Session as the scan sees it. */
export interface ReferencedSessions {
  readonly persistence: {
    list(): Promise<readonly { readonly header: { readonly id: SessionId } }[]>
    open(id: SessionId, access: 'read'): Promise<{
      read(): Promise<{ readonly events: readonly unknown[] }>
      close(): Promise<void>
    }>
  }
}

/**
 * Collect every digest the stored Sessions name.
 *
 * The event objects are serialized whole and searched for `sha256:<hex>`: the
 * id travels inside content parts, and a match in unrelated text only keeps an
 * object that might have been collectable.
 * @param sessions - the Session store to read.
 * @param warn - sink for a contained failure; any failure abandons the scan.
 * @returns the referenced digests, or `undefined` when a log could not be read.
 */
export async function collectReferencedDigests(
  sessions: ReferencedSessions,
  warn: (message: string) => void,
): Promise<Set<string> | undefined> {
  const referenced = new Set<string>()
  let stored: readonly { readonly header: { readonly id: SessionId } }[]
  try {
    stored = await sessions.persistence.list()
  } catch (error: unknown) {
    warn(`attachment gc: session list unavailable, sweep skipped: ${String(error)}`)
    return undefined
  }
  for (const snapshot of stored) {
    let handle
    try {
      handle = await sessions.persistence.open(snapshot.header.id, 'read')
    } catch (error: unknown) {
      warn(`attachment gc: session "${snapshot.header.id}" could not be opened, sweep skipped: ${String(error)}`)
      return undefined
    }
    try {
      const { events } = await handle.read()
      for (const event of events) {
        for (const digest of digestsIn(JSON.stringify(event) ?? '')) referenced.add(digest)
      }
    } catch (error: unknown) {
      warn(`attachment gc: session "${snapshot.header.id}" could not be read, sweep skipped: ${String(error)}`)
      return undefined
    } finally {
      await handle.close().catch(() => undefined)
    }
  }
  return referenced
}

/** Read the last completed sweep time, or `undefined` when the marker is absent or unreadable. */
export function lastSweepMs(markerPath: string): number | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(markerPath, 'utf8'))
    const at = (value as { at?: unknown } | null)?.at
    return typeof at === 'number' && Number.isSafeInteger(at) ? at : undefined
  } catch {
    return undefined
  }
}

/** Record one completed sweep; a marker that cannot be written only means the next start retries. */
export function recordSweep(markerPath: string, at: number): void {
  try {
    mkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 })
    writeFileSync(markerPath, `${JSON.stringify({ at })}\n`, { mode: 0o600 })
  } catch {
    // The sweep already happened; the marker is only a throttle.
  }
}

/**
 * Run the maintenance once when it is due.
 * @param ctx - the booted Host context, read for the attachment and Session stores.
 * @param now - wall-clock milliseconds, injected for tests.
 * @returns what was reclaimed, or `undefined` when the run was skipped.
 */
export async function runAttachmentMaintenance(
  ctx: Context,
  now = Date.now(),
): Promise<AttachmentSweepResult | undefined> {
  const attachments = ctx.get('attachments')
  const persistence = ctx.get('sessionPersistence')
  const root = attachments?.root
  if (attachments === undefined || persistence === undefined || root === undefined) return undefined
  // Resolved from the Harness home the Host was started with; the Desktop shell
  // passes its profile root, so the marker lands beside the other caches.
  const markerPath = dshCachePath(MARKER_NAME)
  const last = lastSweepMs(markerPath)
  if (last !== undefined && now - last < ATTACHMENT_SWEEP_INTERVAL_MS) return undefined
  const warn = (message: string): void => { ctx.logger('desktop-attachment-gc').warn(message) }
  const referenced = await collectReferencedDigests({ persistence }, warn)
  if (referenced === undefined) return undefined
  const result = await sweepUnreferencedObjects({
    root,
    referenced,
    protectSinceMs: now - ATTACHMENT_PROTECT_MS,
    warn,
  })
  recordSweep(markerPath, now)
  if (result.deletedFiles > 0) {
    ctx.logger('desktop-attachment-gc').info(
      `attachment gc: reclaimed ${String(result.deletedFiles)} object(s), ${String(result.freedBytes)} bytes; `
      + `${String(result.remainingBytes)} bytes remain`,
    )
  }
  return result
}

/**
 * Start the maintenance without delaying the Host's startup tail.
 * @param ctx - the booted Host context.
 * @returns a disposer once the run settles, so Host teardown can wait for it.
 */
export function installAttachmentMaintenance(ctx: Context): Promise<void> {
  return runAttachmentMaintenance(ctx).then(() => undefined).catch((error: unknown) => {
    ctx.logger('desktop-attachment-gc').warn(`attachment gc skipped: ${String(error)}`)
  })
}
