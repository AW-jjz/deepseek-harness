// @vitest-environment jsdom
/**
 * Frame preferences persistence: hydrate once from the Host document, write
 * only what the user changed, and never rewrite a default nobody touched.
 */

import { Context } from '@deepseek-ai/cordis'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { persistFramePreferences } from '../src/client/persist.ts'
import { createLayoutStore } from '../src/client/stores.ts'
import { LAYOUT_SETTINGS_NAMESPACE, type LayoutSettings } from '../src/layout-settings.ts'
import type { MainPanelId } from '../src/client/service.ts'

let ctx: Context

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1920)
  ctx = new Context()
})

afterEach(async () => {
  vi.useRealTimers()
  await ctx.fiber.dispose()
})

/** A store instance plus the persistence binding over one stubbed settings scope. */
function bench() {
  const form = stubConfigForm<LayoutSettings>()
  ctx.provide('configForms', { get: (id: string) => id === LAYOUT_SETTINGS_NAMESPACE ? form.scope : undefined })
  const handle = createLayoutStore()
  const store = handle.create()
  const dispose = persistFramePreferences(ctx, store)
  return { form, store, dispose }
}

describe('frame preference persistence', () => {
  it('hydrates the widths and panel from the Host document without writing them back', () => {
    vi.useFakeTimers()
    const { form, store } = bench()
    form.publish({ status: 'ready', value: { sidebarWidth: 320, rightPanelWidth: 500, activePanelId: 'tasks' }, writable: true })
    vi.advanceTimersByTime(1_000)

    const snapshot = store.getSnapshot()
    expect(snapshot.layoutInfo.sidebar).toBe(320)
    expect(snapshot.layoutInfo.rightbar).toBe(500)
    expect(snapshot.panelInfo.activePanelId).toBe('tasks')
    expect(form.set).not.toHaveBeenCalled()
  })

  it('writes one settled width per drag instead of every intermediate value', () => {
    vi.useFakeTimers()
    const { form, store } = bench()
    form.publish({ status: 'ready', value: {}, writable: true })

    store.actions.setSidebar(300)
    store.actions.setSidebar(310)
    store.actions.setSidebar(312)
    expect(form.set).not.toHaveBeenCalled()
    vi.advanceTimersByTime(600)

    expect(form.set).toHaveBeenCalledExactlyOnceWith('sidebarWidth', 312)
  })

  it('keeps a width saved on a wide monitor inside the frame it reopens in', () => {
    vi.stubGlobal('innerWidth', 700)
    const { form, store } = bench()
    form.publish({ status: 'ready', value: { sidebarWidth: 400, rightPanelWidth: 900 }, writable: true })

    // The store clamps on apply, which is what stops a saved 900px panel from
    // covering a phone-width frame.
    expect(store.getSnapshot().layoutInfo.sidebar).toBe(400)
    expect(store.getSnapshot().layoutInfo.rightbar).toBeLessThan(900)
  })

  it('persists the selected main panel', () => {
    vi.useFakeTimers()
    const { form, store } = bench()
    form.publish({ status: 'ready', value: {}, writable: true })

    store.actions.selectPanel('tasks' as MainPanelId)
    vi.advanceTimersByTime(600)

    expect(form.set).toHaveBeenCalledExactlyOnceWith('activePanelId', 'tasks')
  })

  it('leaves the defaults alone until the user changes them', () => {
    vi.useFakeTimers()
    const { form, store } = bench()
    form.publish({ status: 'ready', value: {}, writable: true })

    store.actions.setViewportWidth(1600)
    vi.advanceTimersByTime(600)

    expect(form.set).not.toHaveBeenCalled()
  })

  it('drops a pending write when the frame tears down', () => {
    vi.useFakeTimers()
    const { form, store, dispose } = bench()
    form.publish({ status: 'ready', value: {}, writable: true })

    store.actions.setSidebar(340)
    dispose()
    vi.advanceTimersByTime(1_000)

    expect(form.set).not.toHaveBeenCalled()
    expect(form.listenerCount()).toBe(0)
  })

  it('stays inert when the deployment has no settings transport', () => {
    const handle = createLayoutStore()
    const store = handle.create()
    const dispose = persistFramePreferences(ctx, store)
    expect(() => { store.actions.setSidebar(300); dispose() }).not.toThrow()
  })
})
