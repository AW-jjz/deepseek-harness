/**
 * Device-local window geometry in Electron userData.
 *
 * The saved rectangle is a preference, not a promise: monitors are unplugged,
 * resolutions change, and a window restored exactly where it was can land
 * entirely outside every display. Every read therefore passes through
 * {@link placeWindow}, which keeps a usable part on a screen and otherwise
 * recenters at the default size.
 * @module dsh-desktop/window-state
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Size the window opens at when nothing usable is saved. */
export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 820 } as const

/** Smallest window the shell allows; a restored rectangle never goes below it. */
export const MINIMUM_WINDOW_SIZE = { width: 520, height: 600 } as const

/** Largest accepted coordinate; anything beyond this is a corrupt record, not a monitor. */
const COORDINATE_LIMIT = 100_000

/** Saved geometry: the normal (pre-maximize) rectangle plus whether it was maximized. */
export interface WindowGeometry {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly maximized: boolean
}

/** One display's usable area, as Electron reports it. */
export interface WorkArea {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Where the window should open. */
export interface WindowPlacement {
  /** Explicit rectangle, or absent to let the platform place a default-size window. */
  readonly bounds?: { x: number; y: number; width: number; height: number }
  readonly maximized: boolean
}

/** Absolute path of the geometry record. */
export function windowStatePath(userData: string): string {
  return join(userData, 'window-state.json')
}

function integer(value: unknown, limit: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= limit ? value : undefined
}

function dimension(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= COORDINATE_LIMIT
    ? value
    : undefined
}

/**
 * Parse a saved geometry record, refusing anything that is not one.
 * @param raw - file contents, or any untrusted value.
 * @returns the geometry, or `undefined` when the record is absent or unreadable.
 */
export function parseWindowGeometry(raw: unknown): WindowGeometry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const x = integer(record.x, COORDINATE_LIMIT)
  const y = integer(record.y, COORDINATE_LIMIT)
  const width = dimension(record.width)
  const height = dimension(record.height)
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
  return { x, y, width, height, maximized: record.maximized === true }
}

/**
 * Read the saved geometry; an unreadable file reads as none saved.
 * @param userData - Electron-owned userData directory.
 * @returns saved geometry, or `undefined` before the first save.
 */
export function readWindowGeometry(userData: string): WindowGeometry | undefined {
  try {
    return parseWindowGeometry(JSON.parse(readFileSync(windowStatePath(userData), 'utf8')))
  } catch {
    return undefined
  }
}

/**
 * Persist one geometry record atomically.
 * @param userData - Electron-owned userData directory.
 * @param geometry - rectangle to remember.
 * @returns resolves after the replacement lands.
 */
export function writeWindowGeometry(userData: string, geometry: WindowGeometry): Promise<void> {
  return writeFileAtomic(windowStatePath(userData), `${JSON.stringify(geometry)}\n`, { mode: 0o600, dirMode: 0o700 })
}

/**
 * Keep a usable part of the window on some display.
 * @param saved - saved geometry, or `undefined`.
 * @param displays - every display's work area, primary first (as the shell orders them).
 * @returns the rectangle to create the window with, or no bounds for the default placement.
 */
export function placeWindow(saved: WindowGeometry | undefined, displays: readonly WorkArea[]): WindowPlacement {
  if (saved === undefined) return { maximized: false }
  const width = Math.max(MINIMUM_WINDOW_SIZE.width, saved.width)
  const height = Math.max(MINIMUM_WINDOW_SIZE.height, saved.height)
  // A rectangle counts as visible when at least this much of it is inside one
  // work area: enough to grab the title bar and drag the window back.
  const visible = displays.some(area =>
    Math.min(saved.x + width, area.x + area.width) - Math.max(saved.x, area.x) >= Math.min(width, 160)
    && Math.min(saved.y + height, area.y + area.height) - Math.max(saved.y, area.y) >= Math.min(height, 80))
  if (visible) {
    // A monitor that shrank still owns the window: clamp the size to the work
    // area that holds its origin so the resize handles stay reachable.
    const host = displays.find(area => saved.x >= area.x && saved.x < area.x + area.width
      && saved.y >= area.y && saved.y < area.y + area.height)
    return {
      bounds: {
        x: saved.x,
        y: saved.y,
        width: host === undefined ? width : Math.min(width, host.width),
        height: host === undefined ? height : Math.min(height, host.height),
      },
      maximized: saved.maximized,
    }
  }
  const primary = displays[0]
  // No reported display (headless or a platform race): the platform places it,
  // but whether the user left it maximized is still known.
  if (primary === undefined) return { maximized: saved.maximized }
  const boundedWidth = Math.min(width, primary.width)
  const boundedHeight = Math.min(height, primary.height)
  return {
    bounds: {
      x: Math.round(primary.x + (primary.width - boundedWidth) / 2),
      y: Math.round(primary.y + (primary.height - boundedHeight) / 2),
      width: boundedWidth,
      height: boundedHeight,
    },
    maximized: saved.maximized,
  }
}
