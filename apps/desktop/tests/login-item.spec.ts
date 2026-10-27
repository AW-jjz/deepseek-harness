/** Login-item registration and the hidden-start decision it implies. */

import { afterEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  setLoginItemSettings: vi.fn<(settings: Record<string, unknown>) => void>(),
  getLoginItemSettings: vi.fn<() => { openAtLogin: boolean; wasOpenedAtLogin?: boolean }>(() => ({ openAtLogin: false })),
}))

vi.mock('electron', () => ({
  app: {
    setLoginItemSettings: native.setLoginItemSettings,
    getLoginItemSettings: native.getLoginItemSettings,
  },
}))

const { START_HIDDEN_ARG, applyStartAtLogin, launchOrigin, launchedHidden, startAtLoginEnabled } =
  await import('../src/login-item.ts')

afterEach(() => { vi.clearAllMocks() })

it('starts hidden only for a login-item launch', () => {
  expect(launchedHidden({ argv: ['app.exe', START_HIDDEN_ARG], openedAtLogin: false })).toBe(true)
  expect(launchedHidden({ argv: ['app.exe'], openedAtLogin: true })).toBe(true)
  expect(launchedHidden({ argv: ['app.exe'], openedAtLogin: false })).toBe(false)
})

it('registers the marker argument on Windows and Linux and the hidden flag on macOS', () => {
  applyStartAtLogin(true, 'win32')
  expect(native.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true, args: [START_HIDDEN_ARG] })
  applyStartAtLogin(true, 'linux')
  expect(native.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true, args: [START_HIDDEN_ARG] })
  applyStartAtLogin(true, 'darwin')
  expect(native.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true, openAsHidden: true })
})

it('removes the login item with the same registration shape', () => {
  applyStartAtLogin(false, 'win32')
  expect(native.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false, args: [START_HIDDEN_ARG] })
})

it('reads the registered state from the platform', () => {
  native.getLoginItemSettings.mockReturnValueOnce({ openAtLogin: true })
  expect(startAtLoginEnabled()).toBe(true)
  native.getLoginItemSettings.mockReturnValueOnce({ openAtLogin: false })
  expect(startAtLoginEnabled()).toBe(false)
})

it('reports a macOS login launch and ignores the flag elsewhere', () => {
  native.getLoginItemSettings.mockReturnValue({ openAtLogin: true, wasOpenedAtLogin: true })
  expect(launchOrigin(['app'], 'darwin')).toEqual({ argv: ['app'], openedAtLogin: true })
  expect(launchOrigin(['app'], 'win32')).toEqual({ argv: ['app'], openedAtLogin: false })
})
