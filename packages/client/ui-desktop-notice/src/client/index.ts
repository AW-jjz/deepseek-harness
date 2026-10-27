/**
 * Desktop task notifications, browser half.
 *
 * The shell exposes `window.dshDesktop.notifications` only in the Desktop
 * application; a browser tab has no such bridge and this plugin then does
 * nothing. Where it exists, every authoritative session-list update is folded
 * through {@link RunningTurns}: a turn that ran for at least
 * {@link NOTICE_MINIMUM_MS} and ended while the document was hidden becomes one
 * native notification, and clicking it returns to that session.
 *
 * Notifications are not a second inbox: the same turn keeps its failure row,
 * its completion stays visible in the transcript, and nothing here changes what
 * the session recorded.
 * @module @deepseek-ai/dsh-client-ui-desktop-notice/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { en, es, fr, de, ja, pt, ru, zh, type DesktopNoticeKey } from './locales.ts'
import { RunningTurns, type TurnState } from './running-turns.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The notification copy. */
    'desktop-notice': DesktopNoticeKey
  }
}

/** Client services this plugin reads: the session catalog, locale copy, and the workspace opener. */
export const inject = ['sessions', 'locale', 'uiWorkspace']

/** Namespace for the notification copy. */
export const NS = 'desktop-notice'

/**
 * Shortest turn that raises a notification. Work a person would not walk away
 * from must not produce a notification: an app that pings after five seconds
 * trains its user to ignore it.
 */
export const NOTICE_MINIMUM_MS = 30_000

/** The slice of the preload bridge this plugin uses; absent outside Desktop. */
export interface DesktopNotificationBridge {
  notify(notice: { readonly sessionId: string; readonly title: string; readonly body: string }): Promise<boolean>
  subscribe(listener: (sessionId: string) => void): () => void
}

/** The slice of the global object the bridge lives on; a browser has no `dshDesktop`. */
export interface DesktopNotificationScope {
  /** Desktop product API, exposed by the shell preload; every field is untrusted here. */
  readonly dshDesktop?: unknown
  /** Any other global the caller happens to pass; nothing here reads them. */
  readonly [key: string]: unknown
}

/**
 * Read the bridge the Desktop preload installed.
 * @param scope - global object to read; injected for tests.
 * @returns the notification face, or undefined in a browser.
 */
export function desktopNotificationBridge(scope: DesktopNotificationScope = globalThis): DesktopNotificationBridge | undefined {
  const product = scope.dshDesktop
  if (typeof product !== 'object' || product === null) return undefined
  const candidate = (product as { notifications?: unknown }).notifications
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const bridge = candidate as Partial<DesktopNotificationBridge>
  if (typeof bridge.notify !== 'function' || typeof bridge.subscribe !== 'function') return undefined
  return bridge as DesktopNotificationBridge
}

/**
 * Client plugin body: watch the session catalog and notify through the shell.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const bridge = desktopNotificationBridge()
  if (bridge === undefined) return

  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'desktop-notice: copy')
  const t = ctx.locale.bind(NS)
  const turns = new RunningTurns(NOTICE_MINIMUM_MS)

  ctx.effect(() => {
    const fold = (): void => {
      const snapshot = ctx.sessions.list.getSnapshot()
      const states = new Map<string, TurnState>()
      for (const id of snapshot.ids) {
        const summary = snapshot.byId[id]
        if (summary === undefined) continue
        states.set(id, { running: summary.running, title: summary.displayTitle })
      }
      // Nothing to announce when the window is in view: the person already sees
      // the transcript, and the fold still has to run to keep the turn's start.
      const announce = document.visibilityState === 'hidden'
      for (const finished of turns.fold(Date.now(), states)) {
        if (!announce) continue
        void bridge.notify({
          sessionId: finished.sessionId,
          title: t('turn.title', { title: finished.title }),
          body: t('turn.body'),
        }).catch(() => {
          // The shell refuses notifications it cannot show; the transcript is
          // still the record, so a refusal needs no user-facing fallback.
        })
      }
    }
    return ctx.sessions.list.subscribe(fold)
  }, 'desktop-notice: turn completion')

  ctx.effect(() => bridge.subscribe((sessionId) => {
    try {
      ctx.uiWorkspace.openSession(sessionId as Parameters<typeof ctx.uiWorkspace.openSession>[0])
    } catch {
      // A session that was removed between the notification and the click has
      // nothing to open; the window is already showing the application.
    }
  }), 'desktop-notice: notification clicks')
}
