/**
 * Frame preferences stored in the Host user-settings document: the widths the
 * user dragged to and the main panel they last selected. Everything else in
 * the layout store is derived (viewport measurements, responsive collapse,
 * whether a panel's occupant is expanded), so it is deliberately not saved.
 *
 * The widths are stored unclamped and clamped again on read: a value saved on a
 * large monitor must not force an impossible width on a small one.
 * @module @deepseek-ai/dsh-client-ui-layout/layout-settings
 */
import z from '@deepseek-ai/schemastery'

/** Settings namespace; the Host entry id of this plugin. */
export const LAYOUT_SETTINGS_NAMESPACE = 'ui-layout'

/** Upper bound any stored width may claim; the store clamps to the real range. */
const STORED_WIDTH_MAX = 10_000

/** Saved frame preferences. */
export interface LayoutSettings {
  /** Sidebar width the user dragged to, in CSS pixels; absent until the first drag. */
  sidebarWidth?: number | null
  /** Right panel width the user dragged to, in CSS pixels; absent until the first drag. */
  rightPanelWidth?: number | null
  /** Main panel the user selected last; absent or `null` means the Conversation. */
  activePanelId?: string | null
}

/** Field names shared by the schema, the client, and tests. */
export const LAYOUT_SETTINGS_FIELDS = {
  sidebarWidth: 'sidebarWidth',
  rightPanelWidth: 'rightPanelWidth',
  activePanelId: 'activePanelId',
} as const

/** Durable layout schema; also the wire envelope the browser scope validates against. */
export const LayoutSettingsFields = {
  [LAYOUT_SETTINGS_FIELDS.sidebarWidth]: z.number().min(0).max(STORED_WIDTH_MAX).required(false),
  [LAYOUT_SETTINGS_FIELDS.rightPanelWidth]: z.number().min(0).max(STORED_WIDTH_MAX).required(false),
  [LAYOUT_SETTINGS_FIELDS.activePanelId]: z.string().required(false),
}

/** Schema for the shared layout preferences. */
export const LayoutSettingsSchema = z.object(LayoutSettingsFields)
