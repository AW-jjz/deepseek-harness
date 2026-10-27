/** Index source URL validation shared by `setIndexes` and the per-use check of configured sources. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** Loopback host names that may use plain http: an index served from this machine is not in transit. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * Validate and normalize one index source URL.
 *
 * The index decides which packages a user is offered, so it travels over https
 * unless it is served from this machine: a plain-http index on a real host is
 * something anyone on the path can rewrite.
 * @param text - URL as configured or entered.
 * @returns the URL's serialization.
 * @throws {RemoteError} `plugin-market/invalid-index-url` for anything but a secure URL without credentials or
 * fragment.
 */
export function normalizeIndexUrl(text: string): string {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    // Unparseable text: report the rule instead of the parser message.
    throw new RemoteError('plugin-market/invalid-index-url', `Not an absolute URL: ${text}`, { url: text, reason: 'not-absolute' })
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new RemoteError('plugin-market/invalid-index-url', `Index URLs use http or https: ${text}`, { url: text, reason: 'scheme' })
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new RemoteError('plugin-market/invalid-index-url',
      `Index URLs use https; plain http is only allowed for a loopback host: ${text}`,
      { url: text, reason: 'insecure' })
  }
  if (url.username !== '' || url.password !== '' || url.href.includes('#')) {
    throw new RemoteError('plugin-market/invalid-index-url', `Index URLs carry no credentials or fragment: ${text}`, { url: text, reason: 'credentials-or-fragment' })
  }
  return url.href
}
