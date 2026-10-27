/**
 * Native notification for work that finished while the window was out of sight.
 *
 * The renderer decides when a notification is warranted — a turn that ran long
 * enough and ended while the document was hidden — and localizes the copy. The
 * shell owns the platform notification, the "window is visible again" guard,
 * and the click that brings the user back to the session. Nothing here grants
 * authority: an open request only reveals the window and selects a session.
 * @module dsh-desktop/task-notice
 */
import { Notification } from 'electron'
import type { DesktopTaskNotice } from './ipc.ts'

/** Longest notification copy the shell accepts from the renderer, in characters. */
const MAX_TITLE = 200

/** Longest notification body the shell accepts from the renderer, in characters. */
const MAX_BODY = 600

/** How many notifications may stay live before the oldest is released. */
const MAX_LIVE = 3

/** Options the shell supplies. */
export interface DesktopTaskNoticeOptions {
  /** Whether the user asked to be notified when work finishes. */
  readonly enabled: () => boolean
  /** Whether the primary window is visible and focused, in which case nothing is shown. */
  readonly windowInView: () => boolean
  /** Bring the window back and select one session. */
  readonly open: (sessionId: string) => void
}

/** One accepted notification: the record kept only so a click can still find it. */
interface LiveNotice {
  readonly notification: Notification
  readonly sessionId: string
}

/**
 * Accept, validate, and show task notifications.
 *
 * Notifications are silent and never steal focus: the click is the only action,
 * and it runs the same reveal path the tray uses.
 */
export class DesktopTaskNotices {
  private readonly live: LiveNotice[] = []

  /** @param options - enablement, the window-visibility guard, and the open action. */
  constructor(private readonly options: DesktopTaskNoticeOptions) {}

  /**
   * Show one notification when the user can use it.
   * @param request - untrusted renderer payload: session id and localized copy.
   * @returns true when a notification was shown.
   */
  show(request: unknown): boolean {
    const notice = this.validate(request)
    if (notice === undefined) return false
    if (!this.options.enabled()) return false
    // The renderer suppresses notifications it believes are unnecessary; this
    // re-check covers a stale belief (focused again between send and receipt).
    if (this.options.windowInView()) return false
    try {
      if (!Notification.isSupported()) return false
      const notification = new Notification({ title: notice.title, body: notice.body, silent: true })
      const entry: LiveNotice = { notification, sessionId: notice.sessionId }
      const forget = (): void => {
        notification.removeAllListeners()
        const index = this.live.indexOf(entry)
        if (index !== -1) this.live.splice(index, 1)
      }
      notification.once('click', () => {
        forget()
        try {
          this.options.open(notice.sessionId)
        } catch (error: unknown) {
          // A click must not escape into the platform's notification dispatch.
          console.warn('desktop task notice: open failed', error)
        }
      })
      notification.once('close', forget)
      notification.once('failed', forget)
      this.live.push(entry)
      while (this.live.length > MAX_LIVE) this.live.shift()?.notification.removeAllListeners()
      notification.show()
      return true
    } catch (error: unknown) {
      console.warn('desktop task notice: unavailable', error)
      return false
    }
  }

  /** Release every live notification; called when the shell quits. */
  dispose(): void {
    for (const entry of this.live.splice(0)) entry.notification.removeAllListeners()
  }

  /** Accept only a well-formed, bounded payload from the renderer. */
  private validate(request: unknown): DesktopTaskNotice | undefined {
    if (typeof request !== 'object' || request === null) return undefined
    const candidate = request as { sessionId?: unknown; title?: unknown; body?: unknown }
    if (typeof candidate.sessionId !== 'string' || candidate.sessionId === '') return undefined
    if (typeof candidate.title !== 'string' || candidate.title === '' || candidate.title.length > MAX_TITLE) return undefined
    if (typeof candidate.body !== 'string' || candidate.body === '' || candidate.body.length > MAX_BODY) return undefined
    return { sessionId: candidate.sessionId, title: candidate.title, body: candidate.body }
  }
}
