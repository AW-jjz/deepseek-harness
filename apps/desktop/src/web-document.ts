/** Local Web document and authenticated HTTP forwarding for the application window. */
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
}
const BOOT = '<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>'

/** Deadline for one Host authentication exchange; the window cannot open before it finishes. */
export const AUTHENTICATION_TIMEOUT_MS = 5_000

/** Attempts before startup reports the Host as unreachable. */
export const AUTHENTICATION_ATTEMPTS = 3

/** Pause between attempts; a cold profile can block the Host loop for a moment after `ready`. */
const AUTHENTICATION_RETRY_MS = 500

/**
 * Policy for the application document.
 *
 * It blocks what an injected document would otherwise do without a warning: load script from a
 * remote origin and talk to a remote origin. What the client actually uses stays allowed — inline
 * boot scripts and Host injections, blob workers for upload/excel/pdf, the loopback Host over HTTP
 * and WebSocket, and remote images.
 *
 * `'unsafe-inline' 'unsafe-eval'` are the deliberate limits. The Host injects inline startup code,
 * and `cordis-client-runner` evaluates client plugin bundles at runtime by design
 * (`packages/extensions/cordis-client-runner/src/client/evaluator.ts`), so a stricter script policy
 * would blank the application. This policy is therefore defense-in-depth against remote loads, not
 * a containment boundary against injected inline code.
 */
export const APPLICATION_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "frame-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  'connect-src \'self\' http://127.0.0.1:* https://127.0.0.1:* ws://127.0.0.1:* wss://127.0.0.1:* http://localhost:* ws://localhost:*',
].join('; ')

/**
 * Read an application-owned static asset; the index waits for asynchronous Host injections.
 * @param request - Local application request.
 * @param root - Packaged Web dist directory.
 * @returns Static response, or a missing/invalid path response.
 */
export async function serveWebDocument(request: Request, root: string): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
  const url = new URL(request.url)
  let pathname: string
  try { pathname = decodeURIComponent(url.pathname) } catch { return new Response(null, { status: 400 }) }
  const target = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
  const directory = resolve(root)
  if (!target.startsWith(directory + sep)) return new Response(null, { status: 403 })
  let body: Buffer
  try { body = await readFile(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404 })
    throw error
  }
  const content = pathname === '/' || pathname === '/index.html'
    ? body.toString().replace('<head>', '<head>' + BOOT) : new Uint8Array(body)
  const isDocument = pathname === '/' || pathname === '/index.html'
  return new Response(request.method === 'HEAD' ? null : content, {
    headers: {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      ...isDocument ? { 'content-security-policy': APPLICATION_CONTENT_SECURITY_POLICY } : {},
    },
  })
}

/**
 * Exchange the Host launch URL for an authority-bound browser cookie.
 *
 * The exchange runs before the window may show the application, so a Host that accepts the
 * connection but never answers would otherwise leave startup waiting forever with no state
 * the shell can report. Each attempt is bounded, and a transport failure is retried: the Host
 * reports `ready` before its loop is free, so a cold profile can miss one short deadline.
 * A non-303 answer is final — it describes the Host's own refusal, not a slow machine.
 * @param url - Authenticated URL reported by the owned Host process.
 * @param timeoutMs - Deadline for one exchange; defaults to {@link AUTHENTICATION_TIMEOUT_MS}.
 * @returns Cookie header for requests forwarded to that Host.
 */
export async function authenticateWebHost(url: string, timeoutMs = AUTHENTICATION_TIMEOUT_MS): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt < AUTHENTICATION_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, AUTHENTICATION_RETRY_MS))
    let response: Response
    try {
      response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      lastError = error
      continue
    }
    const cookie = response.headers.get('set-cookie')
    await response.body?.cancel()
    if (response.status !== 303 || cookie === null) throw new Error('Desktop Host authentication failed')
    const end = cookie.indexOf(';')
    return end < 0 ? cookie : cookie.slice(0, end)
  }
  throw lastError instanceof Error ? lastError : new Error('Desktop Host authentication failed')
}

/**
 * Response headers not relayed to the renderer. `set-cookie` would hand the
 * Host's authentication cookie to the page's cookie jar, which the shell owns
 * instead; the rest describe the Node `fetch` connection (its encoding, length,
 * and hop-by-hop transport), which Chromium never sees.
 */
const WITHHELD_RESPONSE_HEADERS = [
  'set-cookie',
  'content-encoding', 'content-length',
  'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization',
]

/** Host routes whose responses carry immutable cache headers keyed by a per-process revision. */
const PLUGIN_BUNDLE_PATH = /^\/plugins\//u

/**
 * Forward local application requests to its authenticated Host, preserving streaming and cancellation.
 * Plugin bundle responses lose their `cache-control` for `no-store`: the Host marks them immutable
 * under a revision that changes every launch, so Chromium's disk cache would only accumulate bundles
 * no later launch can reuse.
 * @param request - Request from the application origin.
 * @param host - Owned Host URL.
 * @param cookie - Host-issued authentication cookie.
 * @returns Host response without connection-level headers.
 */
export async function forwardWebRequest(request: Request, host: string, cookie: string): Promise<Response> {
  const source = new URL(request.url)
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== 'dsh-app://app') return new Response(null, { status: 403 })
  const target = new URL(host)
  target.pathname = source.pathname
  target.search = source.search
  const headers = new Headers(request.headers)
  for (const name of ['host', 'origin', 'cookie', 'sec-fetch-site']) headers.delete(name)
  headers.set('cookie', cookie)
  const init = { method: request.method, headers, body: request.body, signal: request.signal, duplex: 'half', redirect: 'manual' as const }
  const response = await fetch(target, init)
  const outgoing = new Headers(response.headers)
  for (const name of WITHHELD_RESPONSE_HEADERS) outgoing.delete(name)
  if (PLUGIN_BUNDLE_PATH.test(source.pathname)) outgoing.set('cache-control', 'no-store')
  return new Response(response.body, { status: response.status, headers: outgoing })
}
