/**
 * Attachment object retention: reclaim content-addressed bytes no retained
 * Session log names any more.
 *
 * Attachments are stored by digest, so deletion is a mark-and-sweep: a Session
 * log is the only thing that can name an object, and an object no log names is
 * unreachable — the store's own contract says such objects stay until a
 * retention policy collects them. The safety rules are deliberately one-sided:
 * an object is removed only when the whole reference set was read successfully
 * and the object is old enough that a write in flight or a log written moments
 * ago cannot still be about to name it. A false positive (an id that appears in
 * text) only keeps bytes; a false negative would destroy a live attachment, so
 * every read failure abandons the sweep.
 * @module @deepseek-ai/dsh-attachment-local/gc
 */

import { lstat, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** Directories under the attachment root that hold content-addressed objects. */
const OBJECT_DIRECTORIES = ['objects', 'file-objects'] as const

/** One stored object as the sweep sees it. */
export interface StoredObject {
  /** Absolute object path. */
  readonly path: string
  /** Digest naming the object (the file name). */
  readonly digest: string
  /** Size in bytes. */
  readonly bytes: number
  /** Modification time, the only age signal a content-addressed store has. */
  readonly mtimeMs: number
}

/** Options for one sweep. */
export interface AttachmentSweepOptions {
  /** Attachment root (`DSH_HOME/attachments/v1`). */
  readonly root: string
  /** Digests some retained Session log still names. */
  readonly referenced: ReadonlySet<string>
  /** Objects modified at or after this instant are never collected. */
  readonly protectSinceMs: number
  /** Sink for a contained filesystem failure. */
  readonly warn: (message: string) => void
}

/** What one sweep reclaimed. */
export interface AttachmentSweepResult {
  /** Objects deleted. */
  readonly deletedFiles: number
  /** Bytes those objects occupied. */
  readonly freedBytes: number
  /** Bytes the two object trees still hold afterwards. */
  readonly remainingBytes: number
}

/**
 * Whether one object may be collected.
 * @param object - the stored object.
 * @param referenced - digests still named by a retained log.
 * @param protectSinceMs - objects at or after this instant are kept.
 * @returns true when nothing can still name or be about to name the object.
 */
export function isCollectable(object: Pick<StoredObject, 'digest' | 'mtimeMs'>, referenced: ReadonlySet<string>, protectSinceMs: number): boolean {
  return !referenced.has(object.digest) && object.mtimeMs < protectSinceMs
}

/**
 * Enumerate every stored object under both object trees.
 *
 * Only a `<two hex>/<64 hex>` layout is read; a stray file, a differently named
 * directory, and anything that is not a regular file is skipped rather than
 * counted or followed.
 * @param root - attachment root.
 * @param warn - sink for a contained read failure.
 * @returns every regular object, in directory order.
 */
export async function listStoredObjects(root: string, warn: AttachmentSweepOptions['warn']): Promise<StoredObject[]> {
  const objects: StoredObject[] = []
  for (const directory of OBJECT_DIRECTORIES) {
    const base = join(root, directory)
    let shards: string[]
    try {
      shards = await readdir(base)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      warn(`attachment gc: failed to read ${base}: ${String(error)}`)
      continue
    }
    for (const shard of shards) {
      if (!/^[0-9a-f]{2}$/u.test(shard)) continue
      const shardPath = join(base, shard)
      let names: string[]
      try {
        names = await readdir(shardPath)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        warn(`attachment gc: failed to read ${shardPath}: ${String(error)}`)
        continue
      }
      for (const name of names) {
        if (!/^[0-9a-f]{64}$/u.test(name) || !name.startsWith(shard)) continue
        const path = join(shardPath, name)
        try {
          const stats = await lstat(path)
          if (!stats.isFile()) continue
          objects.push({ path, digest: name, bytes: stats.size, mtimeMs: stats.mtimeMs })
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          warn(`attachment gc: failed to stat ${path}: ${String(error)}`)
        }
      }
    }
  }
  return objects
}

/**
 * Collect unreferenced objects older than the protection window.
 *
 * Deletion is best effort per object: a failure leaves that object in place and
 * is reported, because the next sweep can retry it and a half-deleted store has
 * no consumers to serve anyway.
 * @param options - the root, the reference set, the protection cutoff, and the warning sink.
 * @returns what was reclaimed.
 */
export async function sweepUnreferencedObjects(options: AttachmentSweepOptions): Promise<AttachmentSweepResult> {
  const objects = await listStoredObjects(options.root, options.warn)
  let remainingBytes = 0
  let deletedFiles = 0
  let freedBytes = 0
  for (const object of objects) {
    if (!isCollectable(object, options.referenced, options.protectSinceMs)) {
      remainingBytes += object.bytes
      continue
    }
    try {
      await unlink(object.path)
      deletedFiles += 1
      freedBytes += object.bytes
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      remainingBytes += object.bytes
      options.warn(`attachment gc: failed to delete ${object.path}: ${String(error)}`)
    }
  }
  return { deletedFiles, freedBytes, remainingBytes }
}
