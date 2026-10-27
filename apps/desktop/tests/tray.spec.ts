import type { MenuItemConstructorOptions } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import { DesktopTray } from '../src/tray.ts'

const native = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const trays: FakeTray[] = []
  class FakeTray extends EventEmitter {
    readonly setToolTip = vi.fn()
    readonly setContextMenu = vi.fn()
    readonly destroy = vi.fn()
    constructor(readonly image: unknown) { super(); trays.push(this) }
  }
  const menus: MenuItemConstructorOptions[][] = []
  return {
    trays, FakeTray, menus,
    createFromPath: vi.fn((path: string) => ({ path })),
    buildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]) => { menus.push(template); return { template } }),
  }
})
vi.mock('electron', () => ({
  Tray: native.FakeTray,
  nativeImage: { createFromPath: native.createFromPath },
  Menu: { buildFromTemplate: native.buildFromTemplate },
}))

afterEach(() => { native.trays.length = 0; native.menus.length = 0; vi.clearAllMocks() })

function setup(locale = 'en') {
  let current = resolveDesktopLocale(locale)
  const open = vi.fn()
  const quit = vi.fn()
  const toggleStartAtLogin = vi.fn()
  const toggleTaskCompletionNotice = vi.fn()
  let startAtLogin = false
  let taskCompletionNotice = true
  const tray = new DesktopTray({ iconPath: 'C:/app/resources/tray.ico', locale: () => current, open, quit,
    startAtLogin: () => startAtLogin, toggleStartAtLogin,
    taskCompletionNotice: () => taskCompletionNotice, toggleTaskCompletionNotice })
  return { tray, open, quit, toggleStartAtLogin, toggleTaskCompletionNotice,
    setStartAtLogin: (next: boolean) => { startAtLogin = next },
    setTaskCompletionNotice: (next: boolean) => { taskCompletionNotice = next },
    native: native.trays[0]!, setLocale: (next: string) => { current = resolveDesktopLocale(next) } }
}

function labels(menu: MenuItemConstructorOptions[]): (string | undefined)[] {
  return menu.map(item => item.type === 'separator' ? 'separator' : item.label)
}

it('shows the application icon with its name as the tooltip and an Open / Quit menu', () => {
  const f = setup()
  expect(native.createFromPath).toHaveBeenCalledWith('C:/app/resources/tray.ico')
  expect(f.native.image).toEqual({ path: 'C:/app/resources/tray.ico' })
  expect(f.native.setToolTip).toHaveBeenCalledWith('DeepSeek Harness')
  expect(labels(native.menus[0]!)).toEqual([
    'Open DeepSeek Harness', 'separator', 'Start at login', 'Notify when a task finishes', 'separator',
    'Quit DeepSeek Harness',
  ])
  expect(f.native.setContextMenu).toHaveBeenCalledWith({ template: native.menus[0] })
})

it('opens the window on a single click and routes menu entries to the open and quit actions', () => {
  const f = setup()
  f.native.emit('click')
  expect(f.open).toHaveBeenCalledOnce()
  const menu = native.menus[0]!
  ;(menu[0] as { click: () => void }).click()
  ;(menu[5] as { click: () => void }).click()
  expect(f.open).toHaveBeenCalledTimes(2)
  expect(f.quit).toHaveBeenCalledOnce()
})

it('marks both preference rows and routes their toggles', () => {
  const f = setup()
  f.setStartAtLogin(true)
  f.setTaskCompletionNotice(false)
  f.tray.relabel()
  const menu = native.menus.at(-1)!
  const login = menu[2] as { type?: string; checked?: boolean; click: () => void }
  const notice = menu[3] as { type?: string; checked?: boolean; click: () => void }
  expect(login).toMatchObject({ type: 'checkbox', checked: true })
  expect(notice).toMatchObject({ type: 'checkbox', checked: false })
  login.click()
  notice.click()
  expect(f.toggleStartAtLogin).toHaveBeenCalledOnce()
  expect(f.toggleTaskCompletionNotice).toHaveBeenCalledOnce()
})

it('relabels the menu in the current locale and ignores relabel after disposal', () => {
  const f = setup()
  f.setLocale('zh')
  f.tray.relabel()
  expect(labels(native.menus[1]!)).toEqual([
    '打开 DeepSeek Harness', 'separator', '登录时启动', '任务完成后通知', 'separator', '退出 DeepSeek Harness',
  ])
  f.tray.dispose()
  f.tray.dispose()
  expect(f.native.destroy).toHaveBeenCalledOnce()
  f.tray.relabel()
  expect(native.menus).toHaveLength(2)
})
