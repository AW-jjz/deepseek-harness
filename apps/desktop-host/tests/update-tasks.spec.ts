import { Context } from '@deepseek-ai/cordis'
import { JobId, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { JobStatus, JobView } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installDesktopUpdateTaskControl } from '../src/update-tasks.ts'

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
