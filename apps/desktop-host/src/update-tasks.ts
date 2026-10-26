/** Desktop installation admission and task inspection for the shared Web Host. */

import { CordisError, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-client-connection'

/**
 * Whether stopping the Host now would interrupt work: a generating or tool-running
 * agent (including subagents and turns waiting for approval), queued inbox
 * messages, or a running or stopping background job.
 * @param liveAgents - Current agent roster.
 * @param jobs - Job registry queried for the global roster and each agent's own jobs.
 * @returns true when any of those conditions holds.
 */
export function hasDesktopActiveTasks(liveAgents: ReturnType<Context['agents']['list']>, jobs: Context['jobs']): boolean {
  return liveAgents.some(agent => agent.status === 'running'
    || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0)
    || [undefined, ...liveAgents].some(agent => jobs.list(agent?.id)
      .some(job => job.status === 'running' || job.status === 'stopping'))
}

/** How long admitted requests may keep the lock before the drain is abandoned. */
export const DRAIN_BUDGET_MS = 5_000

/** How long a lock may stay held before it releases itself, so the API cannot wedge at 503. */
export const LOCK_STALE_MS = 30_000

/**
 * Register update admission on the owning Host context.
 * @param ctx - Booted Desktop profile context; disposal removes the request listener.
 * @returns Task inspector whose lock refuses new API requests, drains admitted requests, and rechecks work.
 */
export function installDesktopUpdateTaskControl(ctx: Context): (action: 'inspect' | 'lock' | 'unlock') => Promise<boolean> {
  let locked = false
  let lockedAt: number | undefined
  let lockGeneration = 0
  let stopped = false
  let staleLockTimer: NodeJS.Timeout | undefined
  const pendingRequests = new Set<Promise<void>>()
  const releaseLock = (): void => {
    locked = false
    lockedAt = undefined
    if (staleLockTimer !== undefined) { clearTimeout(staleLockTimer); staleLockTimer = undefined }
  }
  try {
    ctx.effect(() => () => { stopped = true })
    ctx.effect(() => () => { releaseLock() })
    ctx.on('connection/request', async (_request, response, next) => {
      // A lock nobody releases must not turn every API response into a permanent 503.
      if (locked && lockedAt !== undefined && Date.now() - lockedAt >= LOCK_STALE_MS) releaseLock()
      if (locked) {
        response.writeHead(503)
        response.end()
        return
      }
      const finished = Promise.withResolvers<void>()
      pendingRequests.add(finished.promise)
      try { await next() }
      finally { pendingRequests.delete(finished.promise); finished.resolve() }
    })
  } catch (error) {
    // A Host already disposing when startup reaches registration must not crash; the
    // inspector reports stopping so update admission fails closed instead of looping.
    if (!(error instanceof CordisError) || error.code !== 'INACTIVE_EFFECT') throw error
    stopped = true
    ctx.logger('desktop-update').warn('update task control skipped registration on a disposing Host context')
  }
  /** Wait for admitted requests, but never longer than {@link DRAIN_BUDGET_MS}. */
  const drainAdmittedRequests = async (): Promise<boolean> => {
    if (pendingRequests.size === 0) return true
    let timer: NodeJS.Timeout | undefined
    const budget = new Promise<false>((resolve) => {
      timer = setTimeout(() => { resolve(false) }, DRAIN_BUDGET_MS)
      timer.unref()
    })
    try {
      return await Promise.race([Promise.all(pendingRequests).then(() => true), budget])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  return async (action) => {
    if (stopped) throw new Error('desktop update: Host is stopping')
    if (action === 'unlock') { releaseLock(); lockGeneration++ }
    const agents = ctx.get('agents')
    const jobs = ctx.get('jobs')
    if (agents === undefined || jobs === undefined) throw new Error('desktop update: task services are unavailable')
    if (action === 'lock') {
      locked = true
      lockedAt = Date.now()
      if (staleLockTimer !== undefined) clearTimeout(staleLockTimer)
      staleLockTimer = setTimeout(() => { releaseLock() }, LOCK_STALE_MS)
      staleLockTimer.unref()
      const generation = ++lockGeneration
      // Read requests are not tasks; admitted writes must finish before the final work check.
      // An unbounded drain would leave the lock (and every API response) waiting forever.
      if (!await drainAdmittedRequests()) {
        throw new Error(`desktop update: admitted requests did not finish draining within ${String(DRAIN_BUDGET_MS)}ms`)
      }
      if (stopped) throw new Error('desktop update: Host is stopping')
      if (generation !== lockGeneration) throw new Error('desktop update: admission lock was superseded')
    }
    return hasDesktopActiveTasks(agents.list(), jobs)
  }
}
