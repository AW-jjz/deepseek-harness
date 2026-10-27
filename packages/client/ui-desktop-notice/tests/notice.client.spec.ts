// @vitest-environment jsdom
/**
 * Desktop task notifications: which finished turns are announced, and what the
 * plugin does when the desktop bridge is absent or a turn was too short.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunningTurns } from '../src/client/running-turns.ts'

afterEach(() => { vi.useRealTimers() })

const state = (running: boolean, title = 'Session') => ({ running, title })

describe('RunningTurns', () => {
  it('reports a turn that ran past the minimum', () => {
    const turns = new RunningTurns(30_000)
    expect(turns.fold(0, new Map([['a', state(true)]]))).toEqual([])
    expect(turns.fold(45_000, new Map([['a', state(false, 'Release work')]])))
      .toEqual([{ sessionId: 'a', title: 'Release work', elapsedMs: 45_000 }])
  })

  it('ignores a turn shorter than the minimum', () => {
    const turns = new RunningTurns(30_000)
    turns.fold(0, new Map([['a', state(true)]]))
    expect(turns.fold(12_000, new Map([['a', state(false)]]))).toEqual([])
  })

  it('does not announce a session first seen already idle', () => {
    const turns = new RunningTurns(30_000)
    expect(turns.fold(0, new Map([['a', state(false)]]))).toEqual([])
    expect(turns.fold(60_000, new Map([['a', state(false)]]))).toEqual([])
  })

  it('measures only the time it observed, not the time the turn really took', () => {
    const turns = new RunningTurns(30_000)
    // Attached mid-turn: the start is this observation, so 20s later is short.
    turns.fold(100_000, new Map([['a', state(true)]]))
    expect(turns.fold(120_000, new Map([['a', state(false)]]))).toEqual([])
  })

  it('announces each turn separately and keeps the display title current', () => {
    const turns = new RunningTurns(1_000)
    const running = new Map([['a', state(true, 'Draft')]])
    turns.fold(0, running)
    turns.fold(2_000, new Map([['a', state(true, 'Renamed')]]))
    expect(turns.fold(3_000, new Map([['a', state(false, 'Renamed')]])))
      .toEqual([{ sessionId: 'a', title: 'Renamed', elapsedMs: 3_000 }])
    turns.fold(4_000, new Map([['a', state(true)]]))
    expect(turns.fold(6_000, new Map([['a', state(false)]])))
      .toHaveLength(1)
  })

  it('forgets a session that disappeared instead of reporting it finished', () => {
    const turns = new RunningTurns(1_000)
    turns.fold(0, new Map([['a', state(true)]]))
    expect(turns.fold(5_000, new Map())).toEqual([])
    // Re-appearing idle is not the end of the turn it left running.
    expect(turns.fold(6_000, new Map([['a', state(false)]]))).toEqual([])
  })

  it('tracks concurrent sessions independently', () => {
    const turns = new RunningTurns(1_000)
    turns.fold(0, new Map([['a', state(true)], ['b', state(true)]]))
    turns.fold(2_000, new Map([['a', state(false)], ['b', state(true)]]))
    expect(turns.fold(3_000, new Map([['a', state(false)], ['b', state(false)]])))
      .toEqual([{ sessionId: 'b', title: 'Session', elapsedMs: 3_000 }])
  })
})

describe('desktop notification plugin', () => {
  /** Load the plugin with a fresh module graph so global reads happen per test. */
  async function load(url: string): Promise<typeof import('../src/client/index.ts')> {
    vi.resetModules()
    return await import(url)
  }

  it('reads the preload bridge and ignores anything that is not one', async () => {
    const module = await load('../src/client/index.ts')
    expect(module.desktopNotificationBridge({})).toBeUndefined()
    const bridge = { notify: async () => true, subscribe: () => () => {} }
    expect(module.desktopNotificationBridge({ dshDesktop: { notifications: bridge } })).toBe(bridge)
    expect(module.desktopNotificationBridge({
      dshDesktop: { notifications: { notify: 'x', subscribe: () => () => {} } },
    })).toBeUndefined()
  })

  it('declares the services it reads and does nothing without the desktop bridge', async () => {
    const module = await load('../src/client/index.ts')
    expect(module.inject).toEqual(['sessions', 'locale', 'uiWorkspace'])
    const ctx = new Context()
    try {
      // No bridge in this environment: the plugin must return before it reads
      // any injected service, so a bare context is enough.
      expect(() => { module.apply(ctx as never) }).not.toThrow()
    } finally { await ctx.fiber.dispose() }
  })
})
