/** Microphone access belongs to the primary application frame and the operating system. */
import { systemPreferences, type Session, type WebContents } from 'electron'

function applicationFrame(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'dsh-app:' && parsed.hostname === 'app'
  } catch (_error) { return false /* Invalid frame URLs cannot request microphone access. */ }
}

/** Permissions the application UI legitimately uses outside audio capture. */
const ALLOWED_NON_MEDIA = new Set(['clipboard-sanitized-write'])

/**
 * Handle microphone requests from the owned application window.
 *
 * Everything beyond the microphone and a sanitized clipboard write is denied: the default
 * session also carries the welcome page, the update dialogs and policy pages, so an injected
 * document there would otherwise read the clipboard, raise notifications, or read the
 * location without a prompt. Clipboard *reads* stay denied; only the write path that copy
 * buttons need is allowed.
 * @param session - application's browser session.
 * @param primary - current primary window contents, absent while no window is open.
 */
export function installMicrophonePermissions(session: Pick<Session, 'setPermissionCheckHandler' | 'setPermissionRequestHandler'>, primary: () => WebContents | undefined): void {
  session.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (permission !== 'media') return ALLOWED_NON_MEDIA.has(permission)
    return contents != null && contents === primary() && details.isMainFrame
      && applicationFrame(origin) && details.mediaType === 'audio'
      && (process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('microphone') === 'granted')
  })
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== 'media') { callback(ALLOWED_NON_MEDIA.has(permission)); return }
    const allowed = contents === primary() && details.isMainFrame && applicationFrame(details.requestingUrl)
      && 'mediaTypes' in details && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio'
    if (!allowed) { callback(false); return }
    if (process.platform !== 'darwin') { callback(true); return }
    void systemPreferences.askForMediaAccess('microphone').then(callback, () => { callback(false) })
  })
}
