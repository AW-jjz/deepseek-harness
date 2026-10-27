/**
 * Launch-at-login registration for the Desktop shell.
 *
 * The shell registers itself with the operating system's own login-item API, so
 * the entry the OS runs is the same executable with one marker argument. Starting
 * with `--start-hidden` (or, on macOS, from a login item) keeps the window
 * unshown: the tray icon is the way back, which is what an autostart launch is
 * for.
 * @module dsh-desktop/login-item
 */
import { app } from 'electron'

/** Argument the OS passes when the shell is started at login. */
export const START_HIDDEN_ARG = '--start-hidden'

/** Whether this launch is a login-item launch that should stay in the tray. */
export interface LaunchOrigin {
  /** Process arguments, as `process.argv` reports them. */
  readonly argv: readonly string[]
  /** Whether macOS reports this process as opened at login. */
  readonly openedAtLogin: boolean
}

/**
 * Decide whether the shell should start hidden.
 * @param origin - process arguments and the platform's login-item report.
 * @returns true when the window must stay hidden until the tray opens it.
 */
export function launchedHidden(origin: LaunchOrigin): boolean {
  return origin.argv.includes(START_HIDDEN_ARG) || origin.openedAtLogin
}

/**
 * Register or remove the login item.
 *
 * macOS records "open as hidden" as part of the item; Windows and Linux record
 * the marker argument, which the shell reads back through {@link launchedHidden}.
 * @param enabled - whether the OS should start the shell at login.
 * @param platform - host platform, injectable for tests.
 */
export function applyStartAtLogin(enabled: boolean, platform: string = process.platform): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    ...(platform === 'darwin' ? { openAsHidden: true } : { args: [START_HIDDEN_ARG] }),
  })
}

/**
 * Whether the OS currently starts this shell at login.
 *
 * A menu or tray must never fail to build because the platform could not answer
 * this query, so an unavailable or throwing login-item API reads as "not
 * registered" and the toggle can still register it.
 * @returns the login item's `openAtLogin` state, or false when the OS cannot report it.
 */
export function startAtLoginEnabled(): boolean {
  try {
    return app.getLoginItemSettings().openAtLogin === true
  } catch {
    return false
  }
}

/**
 * The origin of this process's launch.
 * @param argv - process arguments.
 * @param platform - host platform, injectable for tests.
 * @returns what {@link launchedHidden} reads.
 */
export function launchOrigin(argv: readonly string[], platform: string = process.platform): LaunchOrigin {
  let wasOpenedAtLogin = false
  if (platform === 'darwin') {
    try {
      wasOpenedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin === true
    } catch {
      // An unanswerable query is not a login launch: the shell starts normally.
    }
  }
  return { argv, openedAtLogin: wasOpenedAtLogin }
}
