/** Origin checks for endpoints the Desktop Host reports to the shell over IPC. */

/** Loopback hostnames this machine can talk to without leaving it; `[::1]` is how `URL` prints IPv6 loopback. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Normalize a Host-reported URL to its origin when it names this machine over http(s).
 *
 * The shell forwards its Host cookie and API traffic to whatever origin the `ready` event
 * carries, so a non-loopback value is not a warning but a redirect of the session.
 * @param value - URL or bare origin reported by the Host.
 * @returns The normalized origin, or undefined when the value is not a credential-free loopback http(s) URL.
 */
export function loopbackOrigin(value: string): string | undefined {
  let url: URL
  try { url = new URL(value) } catch { return undefined }
  if (url.username !== '' || url.password !== '') return undefined
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return undefined
  return url.origin
}
