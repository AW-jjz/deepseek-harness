/**
 * Session removal into the recycle bin: a removed session disappears from
 * listing and opening, stays recoverable in `_trash`, and ages out at mount.
 */

import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function mount(): Promise<{ ctx: Context; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-trash-'))
  roots.push(root)
  const ctx = new Context()
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  return { ctx, root }
}

/** Remove one session through the backend, failing loudly when it has no recycle bin. */
async function remove(ctx: Context, id: SessionId) {
  const result = await ctx.sessionPersistence.delete?.(id)
  if (result === undefined) throw new Error('the jsonl backend must implement delete')
  return result
}

async function writeLog(ctx: Context, id: string): Promise<SessionId> {
  const header = meta(id, '/work')
  const handle = await ctx.sessionPersistence.create(header)
  try {
    await handle.append(oneTurnLog())
  } finally {
    await handle.close()
  }
  return header.id
}

describe('session removal', () => {
  it('parks the session in the trash and stops listing or opening it', async () => {
    const { ctx, root } = await mount()
    try {
      const id = await writeLog(ctx, 'removable')
      expect((await ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id)).toContain(id)

      const result = await remove(ctx, id)
      expect(result.trashedPath).toBeDefined()
      expect(result.trashedPath?.startsWith(join(root, '_trash'))).toBe(true)
      expect((await stat(result.trashedPath!)).isDirectory()).toBe(true)
      // The log still exists inside the recycle bin, so the removal is reversible.
      expect(await readdir(result.trashedPath!)).not.toHaveLength(0)

      expect((await ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id)).not.toContain(id)
      await expect(ctx.sessionPersistence.open(id, 'read')).rejects.toThrow()
      await expect(ctx.sessionPersistence.stat(id)).resolves.toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('reports a session that does not exist', async () => {
    const { ctx } = await mount()
    try {
      await expect(remove(ctx, 'absent' as SessionId)).rejects.toThrow(/not found/u)
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses to delete a session another handle still owns', async () => {
    const { ctx } = await mount()
    try {
      const id = await writeLog(ctx, 'owned')
      const handle = await ctx.sessionPersistence.open(id, 'write')
      try {
        await expect(ctx.sessionPersistence.delete!(id)).rejects.toThrow(/is open/u)
      } finally { await handle.close() }
      // Closing the handle makes the same delete succeed.
      await expect(ctx.sessionPersistence.delete!(id)).resolves.toMatchObject({ trashedPath: expect.any(String) })
    } finally { await ctx.fiber.dispose() }
  })

  it('lets the same id be created again after a removal', async () => {
    const { ctx } = await mount()
    try {
      const id = await writeLog(ctx, 'recreated')
      await remove(ctx, id)
      const again = await writeLog(ctx, 'recreated')
      expect(again).toBe(id)
      expect((await ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id)).toEqual([id])
    } finally { await ctx.fiber.dispose() }
  })
})

describe('trash sweep', () => {
  it('removes entries older than the retention window and keeps the rest', async () => {
    const { ctx, root } = await mount()
    try {
      const old = await writeLog(ctx, 'old-removal')
      const recent = await writeLog(ctx, 'recent-removal')
      const oldPath = (await remove(ctx, old)).trashedPath ?? ''
      const recentPath = (await remove(ctx, recent)).trashedPath ?? ''
      // Rename the old entry so its timestamp reads as 40 days ago.
      const past = join(root, '_trash', `${String(Date.now() - 40 * 24 * 60 * 60 * 1000)}-old-removal`)
      await rename(oldPath, past)
      // An entry whose name carries no timestamp is never swept.
      await mkdir(join(root, '_trash', 'unreadable-entry'), { recursive: true })

      expect(await ctx.sessionPersistence.sweepTrash?.(30)).toBe(1)
      expect(await readdir(join(root, '_trash')).then(names => names.sort()))
        .toEqual([basename(recentPath), 'unreadable-entry'].sort())
    } finally { await ctx.fiber.dispose() }
  })

  it('does nothing when the trash does not exist or retention is off', async () => {
    const { ctx } = await mount()
    try {
      expect(await ctx.sessionPersistence.sweepTrash?.(30)).toBe(0)
      expect(await ctx.sessionPersistence.sweepTrash?.(0)).toBe(0)
    } finally { await ctx.fiber.dispose() }
  })
})

describe('session restore', () => {
  /** Restore one session through the backend, failing loudly when it has no recovery copy. */
  async function restore(ctx: Context, id: SessionId) {
    const result = await ctx.sessionPersistence.restore?.(id)
    if (result === undefined) throw new Error('the jsonl backend must implement restore')
    return result
  }

  it('puts the session back where it was, and it lists again', async () => {
    const { ctx } = await mount()
    try {
      const id = await writeLog(ctx, 'restorable')
      await remove(ctx, id)
      const restored = await restore(ctx, id)
      expect(restored.restoredPath).toContain('restorable')
      expect((await ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id)).toEqual([id])
      const handle = await ctx.sessionPersistence.open(id, 'read')
      try {
        expect((await handle.read()).events.length).toBeGreaterThan(0)
      } finally { await handle.close() }
    } finally { await ctx.fiber.dispose() }
  })

  it('reports a session with no recovery copy', async () => {
    const { ctx } = await mount()
    try {
      await expect(restore(ctx, 'never-removed' as SessionId)).rejects.toThrow(/not found/u)
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses to overwrite an identity that was used again', async () => {
    const { ctx } = await mount()
    try {
      const id = await writeLog(ctx, 'reused')
      await remove(ctx, id)
      await writeLog(ctx, 'reused')
      await expect(restore(ctx, id)).rejects.toThrow(/exists again/u)
    } finally { await ctx.fiber.dispose() }
  })
})
