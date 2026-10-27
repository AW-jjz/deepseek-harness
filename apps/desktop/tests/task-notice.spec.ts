/** Task notifications: what the shell accepts from the renderer and when it shows nothing. */

import { afterEach, expect, it, vi } from 'vitest'

const native = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const shown: { options: unknown; emit(event: string): void; show: unknown }[] = []
  const state = { supported: true, shown }
  class FakeNotification extends EventEmitter {
    static isSupported(): boolean { return state.supported }
    readonly show = vi.fn()
    constructor(readonly options: unknown) {
      super()
      shown.push(this as never)
    }
  }
  return { state, shown, FakeNotification }
})

vi.mock('electron', () => ({ Notification: native.FakeNotification }))

const { DesktopTaskNotices } = await import('../src/task-notice.ts')

afterEach(() => {
  native.shown.length = 0
  native.state.supported = true
  vi.restoreAllMocks()
})

function bench(over: { enabled?: boolean; inView?: boolean } = {}) {
  const open = vi.fn()
  const notices = new DesktopTaskNotices({
    enabled: () => over.enabled ?? true,
    windowInView: () => over.inView ?? false,
    open,
  })
  return { notices, open }
}

const valid = { sessionId: 'session-1', title: '任务已完成', body: '在后台完成，点击查看。' }

it('shows a silent notification for a well-formed request', () => {
  const { notices } = bench()
  expect(notices.show(valid)).toBe(true)
  expect(native.shown).toHaveLength(1)
  expect(native.shown[0]?.options).toEqual({ title: valid.title, body: valid.body, silent: true })
  expect(native.shown[0]?.show).toHaveBeenCalledOnce()
})

it('opens the session when the notification is clicked, exactly once', () => {
  const { notices, open } = bench()
  notices.show(valid)
  const shown = native.shown[0]!
  shown.emit('click')
  shown.emit('click')
  expect(open).toHaveBeenCalledExactlyOnceWith('session-1')
})

it('stays silent while the window is in view or the preference is off', () => {
  const inView = bench({ inView: true })
  expect(inView.notices.show(valid)).toBe(false)
  const disabled = bench({ enabled: false })
  expect(disabled.notices.show(valid)).toBe(false)
  expect(native.shown).toHaveLength(0)
})

it('rejects payloads it cannot show safely', () => {
  const { notices } = bench()
  for (const request of [
    null, 'text', {}, { ...valid, sessionId: '' }, { ...valid, title: '' }, { ...valid, body: '' },
    { ...valid, title: 'x'.repeat(201) }, { ...valid, body: 'x'.repeat(601) },
    { ...valid, sessionId: 4 },
  ]) {
    expect(notices.show(request)).toBe(false)
  }
  expect(native.shown).toHaveLength(0)
})

it('reports nothing shown when the platform has no notification support', () => {
  native.state.supported = false
  const { notices } = bench()
  expect(notices.show(valid)).toBe(false)
})

it('contains a platform failure instead of rejecting the IPC call', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  native.state.supported = true
  const notices = new DesktopTaskNotices({
    enabled: () => true,
    windowInView: () => false,
    open: () => { throw new Error('window gone') },
  })
  expect(notices.show(valid)).toBe(true)
  native.shown[0]!.emit('click')
  expect(warn).toHaveBeenCalled()
})

it('releases live notifications on disposal', () => {
  const { notices } = bench()
  notices.show(valid)
  const shown = native.shown[0]!
  const removeAll = vi.spyOn(shown, 'removeAllListeners' as never)
  notices.dispose()
  expect(removeAll).toHaveBeenCalled()
  shown.emit('click')
  expect(removeAll).toHaveBeenCalled()
})
