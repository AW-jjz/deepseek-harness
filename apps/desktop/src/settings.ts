/**
 * Local Electron shell settings, loaded once per process independently of the Host.
 * Ownership: .agents/notes/implemented/architecture/2026-10-08-desktop-shell-configuration.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Resolved shell preferences; absent fields use the defaults without rewriting existing files. */
export interface DesktopSettings {
  readonly updates: {
    readonly allowTestAuthPopupWindow: boolean
  }
  readonly launch: {
    /** Whether the operating system starts the shell at login, hidden in the tray. */
    readonly startAtLogin: boolean
  }
  readonly notifications: {
    /** Whether a turn that finishes while the window is hidden raises a native notification. */
    readonly taskCompletion: boolean
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read shell settings, creating the default document exclusively when missing.
 * @param userData - Electron's userData directory, independent of DSH_HOME.
 * @returns Validated settings, or defaults when reading, creating or validating fails; changes require a restart.
 */
export function readDesktopSettings(userData: string): DesktopSettings {
  const directory = join(userData, 'desktop')
  const path = join(directory, 'settings.json')
  const defaults: DesktopSettings = {
    updates: { allowTestAuthPopupWindow: false },
    launch: { startAtLogin: false },
    notifications: { taskCompletion: true },
  }
  try {
    let raw: string
    try { raw = readFileSync(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      try { writeFileSync(path, `${JSON.stringify(defaults, null, 2)}\n`, { flag: 'wx', mode: 0o600 }) } catch (error) {
        // An existing document belongs to the user, including one created during initialization.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      raw = readFileSync(path, 'utf8')
    }
    const value: unknown = JSON.parse(raw)
    if (!record(value) || (value.updates !== undefined && !record(value.updates))
      || (value.launch !== undefined && !record(value.launch))
      || (value.notifications !== undefined && !record(value.notifications))) {
      throw new Error('expected a JSON object with optional updates and launch objects')
    }
    const allow = value.updates?.allowTestAuthPopupWindow
    if (allow !== undefined && typeof allow !== 'boolean') {
      throw new Error('updates.allowTestAuthPopupWindow must be true or false')
    }
    const startAtLogin = value.launch?.startAtLogin
    if (startAtLogin !== undefined && typeof startAtLogin !== 'boolean') {
      throw new Error('launch.startAtLogin must be true or false')
    }
    const taskCompletion = value.notifications?.taskCompletion
    if (taskCompletion !== undefined && typeof taskCompletion !== 'boolean') {
      throw new Error('notifications.taskCompletion must be true or false')
    }
    return {
      updates: { allowTestAuthPopupWindow: allow ?? false },
      launch: { startAtLogin: startAtLogin ?? false },
      notifications: { taskCompletion: taskCompletion ?? true },
    }
  } catch (error) {
    try {
      console.warn(`desktop settings: ${path}: using defaults because settings could not be loaded`, error)
    } catch (_logError) {
      // Diagnostic output is best effort; its failure must not make optional settings fatal.
      // TODO: Persist settings diagnostics when console output is unavailable, without blocking startup.
    }
    return defaults
  }
}

/**
 * Persist the login-item preference, preserving every other field.
 * @param userData - Electron's userData directory.
 * @param enabled - whether the OS should start the shell at login.
 * @returns after the atomic replacement.
 */
export function writeStartAtLogin(userData: string, enabled: boolean): Promise<void> {
  return updateSettings(userData, 'launch', 'startAtLogin', enabled)
}

/**
 * Persist the task-completion notification preference, preserving every other field.
 * @param userData - Electron's userData directory.
 * @param enabled - whether a finished turn should raise a native notification.
 * @returns after the atomic replacement.
 */
export function writeTaskCompletionNotice(userData: string, enabled: boolean): Promise<void> {
  return updateSettings(userData, 'notifications', 'taskCompletion', enabled)
}

/**
 * Replace one boolean field inside one top-level section.
 *
 * A document that cannot be parsed is replaced by one carrying exactly this
 * preference: the alternative is a toggle that silently does nothing.
 * @param userData - Electron's userData directory.
 * @param section - top-level section name.
 * @param field - field inside the section.
 * @param enabled - boolean value to store.
 * @returns after the atomic replacement.
 */
async function updateSettings(userData: string, section: string, field: string, enabled: boolean): Promise<void> {
  const directory = join(userData, 'desktop')
  const path = join(directory, 'settings.json')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  let document: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (record(parsed)) document = { ...parsed }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`desktop settings: ${path}: replacing an unreadable document to store ${section}.${field}`, error)
    }
  }
  const current = record(document[section]) ? { ...document[section] } : {}
  const next = `${JSON.stringify({ ...document, [section]: { ...current, [field]: enabled } }, null, 2)}\n`
  await writeFileAtomic(path, next, { mode: 0o600, dirMode: 0o700 })
}
