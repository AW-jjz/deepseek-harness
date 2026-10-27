/** `session/revealSessionStore`: the Host-owned store directory, never a Client-supplied path. */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import {
  SessionPersistence,
  SessionPersistenceNotFoundError,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it, vi } from 'vitest'
import { createSessionTestController } from './test-remote.ts'

/** Persistence stub that answers only the store location this Remote reads. */
class StoreStub extends SessionPersistence {
  constructor(ctx: Context, root?: string) {
    super(ctx)
    // Only present when the fixture has a store to point at; absent reads as "no store here".
    if (root !== undefined) (this as { root?: string }).root = root
  }

  override create(): Promise<SessionHandle> {
    throw new Error('reveal fixture: create is not used')
  }

  override open(): Promise<SessionHandle> {
    throw new SessionPersistenceNotFoundError(SessionId('unused'))
  }

  override flush(): Promise<void> {
    return Promise.resolve()
  }

  override stat(): Promise<SessionPersistenceSnapshot | undefined> {
    return Promise.resolve(undefined)
  }

  override list(): Promise<readonly SessionPersistenceSnapshot[]> {
    return Promise.resolve([])
  }
}

async function context(root?: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  if (root !== undefined) {
    await ctx.plugin(class extends StoreStub {
      constructor(host: Context) { super(host, root) }
    })
  }
  return ctx
}

const defaults = { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/default' } as const

describe('session/revealSessionStore', () => {
  it('rejects a deployment that stores no sessions here', async () => {
    const ctx = await context()
    try {
      const controller = await createSessionTestController(ctx, { ...defaults })
      await expect(controller.revealSessionStore(new AbortController().signal))
        .rejects.toMatchObject({ code: 'session/store-unavailable' })
    } finally { await ctx.fiber.dispose() }
  })

  it('answers with the path when the deployment cannot open a file manager', async () => {
    const ctx = await context('/store/sessions')
    try {
      const controller = await createSessionTestController(ctx, { ...defaults, canOpenPath: () => false })
      await expect(controller.revealSessionStore(new AbortController().signal))
        .resolves.toEqual({ opened: false, path: '/store/sessions' })
    } finally { await ctx.fiber.dispose() }
  })

  it('reveals the store root itself, without the composed-filesystem check', async () => {
    const ctx = await context('/store/sessions')
    try {
      const revealPath = vi.fn(async (_path: string, _signal: AbortSignal) => {})
      const controller = await createSessionTestController(ctx, { ...defaults, revealPath })
      const signal = new AbortController().signal
      await expect(controller.revealSessionStore(signal))
        .resolves.toEqual({ opened: true, path: '/store/sessions' })
      expect(revealPath).toHaveBeenCalledExactlyOnceWith('/store/sessions', signal)
    } finally { await ctx.fiber.dispose() }
  })

  it('reports a native opener failure as a gateway error', async () => {
    const ctx = await context('/store/sessions')
    try {
      const controller = await createSessionTestController(ctx, {
        ...defaults,
        revealPath: async () => { throw new Error('explorer refused') },
      })
      await expect(controller.revealSessionStore(new AbortController().signal))
        .rejects.toMatchObject({ code: 'gateway/internal', message: 'store reveal failed' })
    } finally { await ctx.fiber.dispose() }
  })
})
