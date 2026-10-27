/**
 * Turn admission against a session store that cannot record: the refusal keeps
 * the failure reportable and costs no model call, an unreadable store admits,
 * and a write that still meets `ENOSPC` keeps a storage code.
 */

import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { STORAGE_BLOCK_BYTES, STORAGE_FULL_CODE, StorageFullError } from '@deepseek-ai/dsh-session-persistence'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { failureCode } from '../src/agent.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

/**
 * A Context with the real JSONL backend under a temporary root, plus that
 * backend's free-space reading replaced so a volume state becomes a test input.
 */
async function harness(
  adapter: MockAdapter,
  read: () => Promise<number | undefined>,
): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-storage-admission-'))
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root })
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('storage-admission fixture: the backend did not mount')
  persistence.availableBytes = async () => read()
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, dispose: async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) } }
}

/** The reason recorded by the last closed Turn of one agent. */
function lastTurnReason(agent: { session: { snapshotEvents(): readonly { type: string; data: unknown }[] } }): unknown {
  const ends = agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
  return (ends.at(-1)?.data as { reason?: unknown } | undefined)?.reason
}

describe('turn storage admission', () => {
  it('refuses a turn below the write margin without calling the model', async () => {
    const adapter = new MockAdapter([textResponse('unused')])
    const { ctx, dispose } = await harness(adapter, async () => STORAGE_BLOCK_BYTES - 1)
    const agent = await ctx.agentLoop.create(SessionId('storage-full'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await dispose()

    expect(adapter.requests).toHaveLength(0)
    expect(lastTurnReason(agent)).toEqual({
      kind: 'error',
      error: {
        message: expect.stringContaining('free, below the 500 MB'),
        code: STORAGE_FULL_CODE,
      },
    })
  })

  it('admits a turn while the store still has room', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const { ctx, dispose } = await harness(adapter, async () => 64 * 1024 * 1024 * 1024)
    const agent = await ctx.agentLoop.create(SessionId('storage-ok'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await dispose()

    expect(adapter.requests).toHaveLength(1)
    expect(lastTurnReason(agent)).toEqual({ kind: 'completed' })
  })

  it('admits a turn when the backend cannot report free space', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const { ctx, dispose } = await harness(adapter, async () => undefined)
    const agent = await ctx.agentLoop.create(SessionId('storage-unknown'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await dispose()

    expect(adapter.requests).toHaveLength(1)
  })

  it('admits a turn when the free-space read itself fails', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const { ctx, dispose } = await harness(adapter, async () => { throw new Error('statfs unavailable') })
    const agent = await ctx.agentLoop.create(SessionId('storage-read-error'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await dispose()

    expect(adapter.requests).toHaveLength(1)
  })

  it('names a write that runs out of space instead of flattening it to UNKNOWN', () => {
    const exhausted = new AggregateError([Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })])
    expect(failureCode(new Error('could not append', { cause: exhausted }))).toBe(STORAGE_FULL_CODE)
    expect(failureCode(new StorageFullError())).toBe(STORAGE_FULL_CODE)
    expect(failureCode(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBe('UNKNOWN')
  })
})
