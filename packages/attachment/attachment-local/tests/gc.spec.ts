/** Attachment object retention: what may be collected, and what a partial scan must never touch. */

import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isCollectable, listStoredObjects, sweepUnreferencedObjects,
} from '../src/gc.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-attachment-gc-'))
  roots.push(root)
  return root
}

const digest = (seed: string): string => seed.repeat(64).slice(0, 64)

/** Write one object into the image (`objects`) or file (`file-objects`) tree. */
async function object(root: string, tree: 'objects' | 'file-objects', hex: string, bytes: number, ageHours = 48): Promise<string> {
  const dir = join(root, tree, hex.slice(0, 2))
  await mkdir(dir, { recursive: true })
  const path = join(dir, hex)
  await writeFile(path, 'x'.repeat(bytes))
  const when = (Date.now() - ageHours * 60 * 60 * 1000) / 1000
  await utimes(path, when, when)
  return path
}

const HOUR = 60 * 60 * 1000

describe('collectable decision', () => {
  it('collects only an unreferenced object past the protection window', () => {
    const referenced = new Set([digest('a')])
    expect(isCollectable({ digest: digest('a'), mtimeMs: Date.now() - 48 * HOUR }, referenced, Date.now() - 24 * HOUR)).toBe(false)
    expect(isCollectable({ digest: digest('b'), mtimeMs: Date.now() - 2 * HOUR }, referenced, Date.now() - 24 * HOUR)).toBe(false)
    expect(isCollectable({ digest: digest('b'), mtimeMs: Date.now() - 48 * HOUR }, referenced, Date.now() - 24 * HOUR)).toBe(true)
  })
})

describe('object sweep', () => {
  it('collects unreferenced old objects from both trees and keeps referenced ones', async () => {
    const root = await freshRoot()
    const referenced = digest('a')
    const orphanImage = await object(root, 'objects', digest('b'), 300)
    const liveImage = await object(root, 'objects', referenced, 200)
    const orphanFile = await object(root, 'file-objects', digest('c'), 100)
    const fresh = await object(root, 'objects', digest('d'), 400, 1)

    const result = await sweepUnreferencedObjects({
      root, referenced: new Set([referenced]), protectSinceMs: Date.now() - 24 * HOUR, warn: () => {},
    })

    expect(result).toEqual({ deletedFiles: 2, freedBytes: 400, remainingBytes: 600 })
    await expect(stat(orphanImage)).rejects.toThrow()
    await expect(stat(orphanFile)).rejects.toThrow()
    expect((await stat(liveImage)).size).toBe(200)
    expect((await stat(fresh)).size).toBe(400)
  })

  it('ignores entries that are not content-addressed object files', async () => {
    const root = await freshRoot()
    const shard = join(root, 'objects', 'ab')
    await mkdir(shard, { recursive: true })
    await writeFile(join(shard, 'not-a-digest'), 'keep me')
    await mkdir(join(root, 'objects', 'zz'), { recursive: true })
    const named = join(shard, digest('e'))
    // A digest whose shard prefix does not match its own name is not the store's layout.
    await writeFile(named, 'mismatched shard')
    const when = (Date.now() - 48 * HOUR) / 1000
    await utimes(named, when, when)

    const objects = await listStoredObjects(root, () => {})
    expect(objects).toEqual([])
    const result = await sweepUnreferencedObjects({ root, referenced: new Set(), protectSinceMs: Date.now(), warn: () => {} })
    expect(result.deletedFiles).toBe(0)
    expect(await readdir(shard)).toEqual(expect.arrayContaining(['not-a-digest', digest('e')]))
  })

  it('reports a read failure and still sweeps the trees it could read', async () => {
    const root = await freshRoot()
    await object(root, 'objects', digest('f'), 10)
    // `file-objects` is replaced by a file, so it cannot be listed.
    await writeFile(join(root, 'file-objects'), 'not a directory')
    const warnings: string[] = []
    const result = await sweepUnreferencedObjects({
      root, referenced: new Set(), protectSinceMs: Date.now(), warn: message => warnings.push(message),
    })
    expect(result.deletedFiles).toBe(1)
    expect(warnings.join('\n')).toContain('file-objects')
  })
})
