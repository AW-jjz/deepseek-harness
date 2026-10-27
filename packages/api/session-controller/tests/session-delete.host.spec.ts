/**
 * `session/delete` and `session/restore`: a stored Session leaves the store into
 * the backend's recovery copy and comes back, while a live one refuses.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { describe, expect, it } from 'vitest'
import { createSessionTestController } from './test-remote.ts'

const roots: string[] = []

async function controller(): Promise<{ ctx: Context; direct: Awaited<ReturnType<typeof createSessionTestController>>; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
  roots.push(root)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  const direct = await createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/default',
  })
  return { ctx, direct, root }
}

async function storeSession(ctx: Context, id: string): Promise<SessionId> {
  const sessionId = id as SessionId
  const handle = await ctx.sessionPersistence.create({
    version: 4, id: sessionId, createdAt: 1, cwd: '/work', isSeeded: false, delegationDepth: 0,
  } as never)
  await handle.append([{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }] as never)
  await handle.close()
  return sessionId
}

describe('session removal over the Remote', () => {
  it('removes a stored session and restores it', async () => {
    const { ctx, direct, root } = await controller()
    try {
      const id = await storeSession(ctx, 'remote-delete')
      const removed = await direct.delete({ sessionId: id }, new AbortController().signal)
      expect(removed.trashedPath).toContain(join(root, '_trash'))
      expect((await ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id)).not.toContain(id)

      const restored = await direct.restore({ sessionId: id }, new AbortController().signal)
      expect(restored.restoredPath).toContain('remote-delete')
      expect((await ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id)).toContain(id)
    } finally { await ctx.fiber.dispose(); await removeRoots() }
  })

  it('reports a session that was never stored', async () => {
    const { ctx, direct } = await controller()
    try {
      await expect(direct.delete({ sessionId: 'absent' as SessionId }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'session/not-found' })
      await expect(direct.restore({ sessionId: 'absent' as SessionId }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'session/not-found' })
    } finally { await ctx.fiber.dispose(); await removeRoots() }
  })
})

async function removeRoots(): Promise<void> {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
}
