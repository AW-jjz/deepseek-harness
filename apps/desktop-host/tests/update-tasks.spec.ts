import { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { JobId, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { JobStatus, JobView } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DRAIN_BUDGET_MS, LOCK_STALE_MS, installDesktopUpdateTaskControl } from '../src/update-tasks.ts'

type AgentState = { id: SessionId; status: 'idle' | 'running'; inbox: { nextTurn: object[]; nextStep: object[] } }

let ctx: Context
let control: ReturnType<typeof installDesktopUpdateTaskControl>
const agents: AgentState[] = []
const jobs = new Map<SessionId | undefined, JobStatus[]>()

/** A registry whose only served member is the per-owner roster the inspector reads. */
class RosterOnlyJobRegistry extends JobRegistry {
  readonly events = { subscribe: () => () => {} }
  start(): never { throw new Error('unsupported') }
  list(caller?: SessionId): JobView[] {
    return (jobs.get(caller) ?? []).map((status, index) => ({
      id: JobId(`bash-${index + 1}`),
      kind: 'bash',
      label: 'sleep 60',
      ...caller === undefined ? {} : { owner: caller },
      status,
      startedAt: 0,
      output: { total: 0, earliest: 0 },
    }))
  }
  get(): never { throw new Error('unsupported') }
  read(): never { throw new Error('unsupported') }
  readAt(): never { throw new Error('unsupported') }
  kill(): never { throw new Error('unsupported') }
  wait(): never { throw new Error('unsupported') }
  remove(): never { throw new Error('unsupported') }
  attachController(): () => void { return () => {} }
}

beforeEach(() => {
  agents.length = 0
  jobs.clear()
  ctx = new Context()
  ctx.provide('agents', { list: () => agents } as never)
  new RosterOnlyJobRegistry(ctx)
  control = installDesktopUpdateTaskControl(ctx)
})

afterEach(async () => { await ctx.fiber.dispose() })

describe('Desktop Host update task control', () => {
  it('reports idle from the shared task rule', async () => {
    agents.push({ id: SessionId('quiet'), status: 'idle', inbox: { nextTurn: [], nextStep: [] } })
    expect(await control('inspect')).toBe(false)
  })

  it('reports active work and keeps the lock through it', async () => {
    agents.push({ id: SessionId('busy'), status: 'running', inbox: { nextTurn: [], nextStep: [] } })
    expect(await control('lock')).toBe(true)
    expect(await control('unlock')).toBe(true)
  })

  it('refuses control after disposal', async () => {
    await ctx.fiber.dispose()
    await expect(control('inspect')).rejects.toThrow('Host is stopping')
  })

  it('abandons a drain that outlives its budget instead of holding the lock forever', async () => {
    vi.useFakeTimers()
    try {
      const hanging = new Promise<never>(() => {})
      const response = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse
      // Admit one request that never finishes; the lock must stop waiting at its budget.
      ctx.emit('connection/request', {} as IncomingMessage, response, () => hanging)
      const locking = expect(control('lock')).rejects.toThrow(/did not finish draining/u)
      await vi.advanceTimersByTimeAsync(DRAIN_BUDGET_MS)
      await locking
      // The shell unlocks on failure; a later request must be served, not answered 503.
      await control('unlock')
      ctx.emit('connection/request', {} as IncomingMessage, response, () => Promise.resolve())
      expect(response.writeHead).not.toHaveBeenCalledWith(503)
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases a lock nobody unlocks so the API cannot wedge at 503', async () => {
    vi.useFakeTimers()
    try {
      expect(await control('lock')).toBe(false)
      await vi.advanceTimersByTimeAsync(LOCK_STALE_MS)
      const response = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse
      ctx.emit('connection/request', {} as IncomingMessage, response, () => Promise.resolve())
      expect(response.writeHead).not.toHaveBeenCalledWith(503)
    } finally {
      vi.useRealTimers()
    }
  })

  it('survives registration on a context that is already unloading and fails closed', async () => {
    // The regression under test: a shutdown that starts unloading the boot context before
    // registration must not crash the Host through the update-task installer either.
    const unloading = new Context()
    const pending = unloading.fiber.dispose()
    let late: ReturnType<typeof installDesktopUpdateTaskControl> | undefined
    expect(() => { late = installDesktopUpdateTaskControl(unloading) }).not.toThrow()
    await pending
    await expect(late!('inspect')).rejects.toThrow('Host is stopping')
  })
})
