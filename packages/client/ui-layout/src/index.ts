/** Host loader entry for the browser-only layout plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
export {
  Config, LAYOUT_SETTINGS_FIELDS, LAYOUT_SETTINGS_NAMESPACE, LayoutSettingsFields,
  LayoutSettingsSchema, type LayoutSettings,
} from './layout-settings.ts'

/**
 * @param ctx Plugin context used for the settings presentation policy.
 */
export function apply(ctx: Context): void {
  // The frame's own defaults apply to a profile that never expresses a
  // preference, so no section is generated for it.
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
