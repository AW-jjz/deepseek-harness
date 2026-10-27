/**
 * Saved window geometry: which records are trustworthy, and where a saved
 * rectangle may reopen on the displays this machine has now.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOW_SIZE,
  MINIMUM_WINDOW_SIZE,
  parseWindowGeometry,
  placeWindow,
  readWindowGeometry,
  windowStatePath,
  writeWindowGeometry,
} from '../src/window-state.ts'
import type { WindowGeometry } from '../src/window-state.ts'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function userData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-window-state-'))
  dirs.push(dir)
  return dir
}

const saved = (over: Partial<WindowGeometry> = {}): WindowGeometry => ({
  x: 120, y: 80, width: 1400, height: 900, maximized: false, ...over,
})

const display = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

describe('saved window geometry', () => {
  it('round-trips through userData', async () => {
    const dir = await userData()
    await writeWindowGeometry(dir, saved({ maximized: true }))
    expect(readWindowGeometry(dir)).toEqual(saved({ maximized: true }))
    expect(await readFile(windowStatePath(dir), 'utf8')).toContain('"maximized":true')
  })

  it('reads an absent or unreadable record as none saved', async () => {
    const dir = await userData()
    expect(readWindowGeometry(dir)).toBeUndefined()
    await writeFile(windowStatePath(dir), '{"x": "left"}')
    expect(readWindowGeometry(dir)).toBeUndefined()
    await writeFile(windowStatePath(dir), 'not json')
    expect(readWindowGeometry(dir)).toBeUndefined()
  })

  it('refuses records that are not a real rectangle', () => {
    expect(parseWindowGeometry(null)).toBeUndefined()
    expect(parseWindowGeometry({ x: 1, y: 2, width: 0, height: 10 })).toBeUndefined()
    expect(parseWindowGeometry({ x: 1, y: 2, width: 10.5, height: 10 })).toBeUndefined()
    expect(parseWindowGeometry({ x: Number.NaN, y: 2, width: 10, height: 10 })).toBeUndefined()
    expect(parseWindowGeometry({ x: 1, y: 2, width: 10, height: 10 })).toEqual({
      x: 1, y: 2, width: 10, height: 10, maximized: false,
    })
  })
})

describe('placing a window on the current displays', () => {
  it('uses the default size when nothing was saved', () => {
    expect(placeWindow(undefined, [display(0, 0, 1920, 1080)])).toEqual({ maximized: false })
    expect(DEFAULT_WINDOW_SIZE).toEqual({ width: 1280, height: 820 })
  })

  it('reopens a saved rectangle that is still on a screen', () => {
    expect(placeWindow(saved(), [display(0, 0, 2560, 1440)])).toEqual({
      bounds: { x: 120, y: 80, width: 1400, height: 900 },
      maximized: false,
    })
  })

  it('keeps the maximized state with the windowed rectangle', () => {
    expect(placeWindow(saved({ maximized: true }), [display(0, 0, 2560, 1440)]).maximized).toBe(true)
  })

  it('recenters on the primary display when the saved monitor is gone', () => {
    // Saved on a second monitor to the right that is no longer attached.
    const placement = placeWindow(saved({ x: 2600, y: 200 }), [display(0, 0, 1920, 1080)])
    expect(placement.bounds).toEqual({ x: 260, y: 90, width: 1400, height: 900 })
  })

  it('shrinks a rectangle saved on a larger monitor to the one that holds it', () => {
    const placement = placeWindow(saved({ x: 0, y: 0, width: 3600, height: 2000 }), [display(0, 0, 1920, 1040)])
    expect(placement.bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
  })

  it('never restores a rectangle smaller than the window minimum', () => {
    const placement = placeWindow(saved({ width: 100, height: 100 }), [display(0, 0, 1920, 1080)])
    expect(placement.bounds).toMatchObject(MINIMUM_WINDOW_SIZE)
  })

  it('recenters when only a sliver of the window would remain visible', () => {
    const placement = placeWindow(saved({ x: -1380, y: 80 }), [display(0, 0, 1920, 1080)])
    expect(placement.bounds).toEqual({ x: 260, y: 90, width: 1400, height: 900 })
  })

  it('leaves placement to the platform when no display is reported', () => {
    const placement = placeWindow(saved({ maximized: true }), [])
    expect(placement.bounds).toBeUndefined()
    expect(placement.maximized).toBe(true)
  })
})
