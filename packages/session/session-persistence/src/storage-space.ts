/**
 * Durable-storage exhaustion vocabulary shared by every persistence backend and
 * by the Agent loop that admits Turns: a Turn a backend cannot record is refused
 * before it starts, and a write that still runs out of space reports the same
 * stable code instead of an anonymous `UNKNOWN` failure.
 * @module @deepseek-ai/dsh-session-persistence/storage-space
 */

/** Stable failure code recorded for a Turn whose session store cannot accept another write. */
export const STORAGE_FULL_CODE = 'STORAGE_FULL'

/**
 * Free space below which a Turn is refused before it writes. A Turn ends by
 * appending its own `turn/end` and the tool results before it, so refusing at
 * zero free bytes would leave the failure itself unrecorded; the margin is what
 * makes the failure reportable.
 */
export const STORAGE_BLOCK_BYTES = 500 * 1024 * 1024

/** Free space below which the Host warns on every Turn while it keeps accepting them. */
export const STORAGE_WARN_BYTES = 2 * 1024 * 1024 * 1024

/** What a free-space reading means for admitting new work. */
export type StorageAdmission =
  /** Unknown or comfortable free space; nothing to do. */
  | { readonly level: 'ok'; readonly freeBytes: number | undefined }
  /** Space is low but work may proceed; the Host warns. */
  | { readonly level: 'warning'; readonly freeBytes: number }
  /** Space is below the write margin; a new Turn is refused. */
  | { readonly level: 'full'; readonly freeBytes: number }

/**
 * A write was refused, or failed, because the backing volume has no usable space.
 *
 * The message names the reading so a log reader does not need the caller's
 * context; the Client replaces it with localized copy and the code routes it.
 */
export class StorageFullError extends Error {
  /** Stable failure code; consumers route on this, never on the message. */
  readonly code = STORAGE_FULL_CODE

  /** @param freeBytes - free space the refusing check observed, when it could read one. */
  constructor(readonly freeBytes?: number, options?: ErrorOptions) {
    super(freeBytes === undefined
      ? 'the session store has no free space'
      : `the session store has ${formatBytes(freeBytes)} free, below the ${formatBytes(STORAGE_BLOCK_BYTES)} a Turn needs to record its own outcome`,
    options)
    this.name = 'StorageFullError'
  }
}

/**
 * Classify one free-space reading against the admission thresholds.
 * @param freeBytes - free bytes the backend reported, or `undefined` when it cannot report.
 * @returns the level that decides whether a Turn is admitted, warned about, or refused.
 */
export function storageAdmission(freeBytes: number | undefined): StorageAdmission {
  if (freeBytes === undefined) return { level: 'ok', freeBytes }
  if (freeBytes < STORAGE_BLOCK_BYTES) return { level: 'full', freeBytes }
  if (freeBytes < STORAGE_WARN_BYTES) return { level: 'warning', freeBytes }
  return { level: 'ok', freeBytes }
}

/** Filesystem failure codes that mean the volume is out of space rather than out of order. */
const EXHAUSTION_CODES: ReadonlySet<string> = new Set(['ENOSPC', 'EDQUOT'])

/**
 * Find a space-exhaustion code anywhere in an error chain.
 *
 * A backend write races the check that admitted it, so the write path can still
 * meet `ENOSPC`; recognizing it here keeps that Turn labeled as a storage
 * failure instead of flattening to `UNKNOWN`. `cause` and `AggregateError.errors`
 * are both followed, because a failed durable write commonly arrives wrapped.
 * @param error - the failure to inspect.
 * @returns the matching filesystem code, or `undefined` for every other failure.
 */
export function storageExhaustion(error: unknown): string | undefined {
  const pending: unknown[] = [error]
  const seen = new Set<unknown>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current !== 'object' || seen.has(current)) continue
    seen.add(current)
    const candidate = current as { code?: unknown; cause?: unknown; errors?: unknown }
    if (typeof candidate.code === 'string' && EXHAUSTION_CODES.has(candidate.code)) return candidate.code
    if (candidate.cause !== undefined) pending.push(candidate.cause)
    if (Array.isArray(candidate.errors)) pending.push(...candidate.errors)
  }
  return undefined
}

/** Render a byte count for a message a person reads: whole MB below a GB, one decimal above. */
function formatBytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024)
  if (megabytes < 1024) return `${Math.max(0, Math.round(megabytes))} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
