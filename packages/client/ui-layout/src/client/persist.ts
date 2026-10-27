/**
 * Binds the frame's saved preferences to the layout store: hydrate once from the
 * Host settings document, then write the values the user actually changes.
 *
 * The baseline is the value in effect after hydration, so a default the user
 * never touched is never written; each write sends only the fields whose value
 * differs from that baseline, and a drag writes once after it settles.
 * @module @deepseek-ai/dsh-client-ui-layout/client/persist
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { LAYOUT_SETTINGS_FIELDS, LAYOUT_SETTINGS_NAMESPACE, type LayoutSettings } from '../layout-settings.ts'
import type { LayoutState } from './stores.ts'

/** How long a drag must settle before one write carries its final width. */
const WRITE_DELAY_MS = 600

/** Store actions as the instance binds them (the draft is supplied by the store). */
interface BoundFrameActions {
  selectPanel(panelId: string | null): void
  setSidebar(px: number): void
  setRightbar(px: number): void
}

/** The slice of a store this binding reads. */
interface FrameStore {
  getSnapshot(): LayoutState
  subscribe(listener: () => void): () => void
  readonly actions: BoundFrameActions
}

/** Values this binding persists, as the store reports them. */
interface FrameValues {
  readonly sidebarWidth: number
  readonly rightPanelWidth: number | null
  readonly activePanelId: string | null
}

function values(store: FrameStore): FrameValues {
  const { panelInfo, layoutInfo } = store.getSnapshot()
  return {
    sidebarWidth: layoutInfo.sidebar,
    rightPanelWidth: layoutInfo.rightbar,
    activePanelId: panelInfo.activePanelId,
  }
}

/**
 * Seed the store from the Host document and persist later user changes.
 * @param ctx - client root context; a deployment without the settings transport gets no persistence.
 * @param store - the frame store instance shared by the service and AppFrame.
 * @returns disposer detaching both subscriptions and cancelling a pending write.
 */
export function persistFramePreferences(ctx: ClientContext, store: FrameStore): () => void {
  const form = ctx.get('configForms')?.get<LayoutSettings>(LAYOUT_SETTINGS_NAMESPACE)
  if (form === undefined) return () => {}

  let hydrated = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let baseline: FrameValues = values(store)

  const hydrate = (): void => {
    const snapshot = form.getSnapshot()
    if (hydrated || snapshot.status !== 'ready' || snapshot.value === undefined) return
    const stored = snapshot.value
    // Apply through the store's actions so a saved width passes the same clamp a
    // drag does. The clamped result, not the stored number, is the baseline:
    // a width saved on a wide monitor must not be rewritten on a narrow one.
    if (typeof stored.sidebarWidth === 'number') store.actions.setSidebar(stored.sidebarWidth)
    if (typeof stored.rightPanelWidth === 'number') store.actions.setRightbar(stored.rightPanelWidth)
    if (typeof stored.activePanelId === 'string') store.actions.selectPanel(stored.activePanelId)
    hydrated = true
    baseline = values(store)
  }

  const writeChanged = (): void => {
    timer = undefined
    if (disposed || !hydrated) return
    const current = values(store)
    const pending: [string, unknown][] = []
    if (current.sidebarWidth !== baseline.sidebarWidth) {
      pending.push([LAYOUT_SETTINGS_FIELDS.sidebarWidth, current.sidebarWidth])
    }
    if (current.rightPanelWidth !== null && current.rightPanelWidth !== baseline.rightPanelWidth) {
      pending.push([LAYOUT_SETTINGS_FIELDS.rightPanelWidth, current.rightPanelWidth])
    }
    if (current.activePanelId !== baseline.activePanelId) {
      pending.push([LAYOUT_SETTINGS_FIELDS.activePanelId, current.activePanelId])
    }
    baseline = {
      sidebarWidth: current.sidebarWidth,
      rightPanelWidth: current.rightPanelWidth ?? baseline.rightPanelWidth,
      activePanelId: current.activePanelId,
    }
    for (const [field, value] of pending) {
      void form.set(field, value).catch(() => {
        // A refused or unreachable write leaves the frame as the user left it;
        // the next change retries through the same ordered write queue.
      })
    }
  }

  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(writeChanged, WRITE_DELAY_MS)
  }

  hydrate()
  const offForm = form.subscribe(hydrate)
  const offStore = store.subscribe(() => { if (hydrated) schedule() })
  return () => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    offStore()
    offForm()
  }
}
