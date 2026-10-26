/** How a renderer failure is handled: reload it, only record it, or treat it as fatal. */

/** Automatic reloads a crashed renderer gets before the failure becomes fatal. */
export const RENDERER_RELOAD_LIMIT = 2

/** How long a reloaded renderer must stay alive before it earns a fresh reload budget. */
export const RENDERER_STABLE_MS = 60_000

/** What the shell does about one renderer failure. */
export type RendererFailureAction = 'ignore' | 'recover' | 'report-only' | 'fatal'

/** Inputs that decide how one renderer failure is handled. */
export interface RendererFailureInput {
  /** The application is quitting and no window state matters any more. */
  readonly quitting: boolean
  /** The window is already gone. */
  readonly destroyed: boolean
  /** The operating system is ending the session, so a dialog would block it. */
  readonly sessionEnding: boolean
  /** Electron's `render-process-gone` reason. */
  readonly reason: string
  /** Whether a reload can plausibly help; a broken preload cannot be reloaded away. */
  readonly recoverable: boolean
  /** Reloads still available in the current budget. */
  readonly reloadsLeft: number
}

/**
 * Decide what to do about one renderer failure.
 *
 * A single page crash should not become a modal failure: the renderer is reloaded while the
 * budget lasts, so a transient fault (an audio context dying, a page jitter) recovers with its
 * state re-fetched from the Host. During a session end a dialog would stall the operating
 * system's shutdown, so nothing is shown and only the crash report is written.
 * @param input - Failure context collected by the window.
 * @returns The action the caller performs.
 */
export function decideRendererFailure(input: RendererFailureInput): RendererFailureAction {
  if (input.quitting || input.destroyed) return 'ignore'
  if (input.reason === 'clean-exit') return 'ignore'
  if (input.sessionEnding) return 'report-only'
  if (!input.recoverable) return 'fatal'
  return input.reloadsLeft > 0 ? 'recover' : 'fatal'
}
