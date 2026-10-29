/** Worker-owned HTTP discovery, DevTools CDP, and Client-ingest endpoints. */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import type { InspectorWorkerConfig } from '../../shared/bridge/messages/control.ts'
import type { WorkerToSourceFrame } from '../../shared/bridge/messages/observation.ts'
import type { InspectorSourceId } from '../../shared/bridge/ids.ts'
import { readInspectorClientSelection } from '../../shared/web.ts'
import { CdpSession } from '../cdp/session.ts'
import type { CdpTransport } from '../cdp/protocol.ts'
import type { NetworkDomain } from '../cdp/domains/network/session.ts'
import type { CordisDomBackend } from '../cdp/domains/dom/index.ts'
import type { CordisRuntimeTreeReader } from '../../shared/cordis/reader.ts'
import type { InspectorQueryRouter } from '../inspection/query-router.ts'
import type { InspectorRealmRegistry } from '../inspection/realm-store.ts'
import type { InspectorSourceRegistry, SourceConnection } from './hub.ts'

/** Bound endpoint information returned to the Host controller. */
export interface InspectorEndpointInfo {
  readonly host: string
  readonly port: number
  readonly targetId: string
}

/**
 * Query parameter carrying the per-run CDP token.
 *
 * A loopback port alone is not access control: any local process can enumerate ports and attach
 * a debugger, and attaching one means `Runtime.evaluate` runs arbitrary code inside this process.
 * The token is random per run and only ever travels in URLs this package prints or returns, so a
 * scanner cannot guess it. It lives in the query string (not a header) because the DevTools
 * frontend opens `webSocketDebuggerUrl` as-is and cannot set request headers.
 */
const CDP_TOKEN_QUERY = 'token'

/** Worker-owned network endpoint. */
export class InspectorEndpoint {
  private server: Server | undefined
  private readonly cdpServer: WebSocketServer
  private readonly ingestServer: WebSocketServer
  private readonly cdpSessions = new Map<WebSocket, CdpSession>()
  private readonly ingestConnections = new Map<WebSocket, SourceConnection>()

  constructor(
    private readonly config: InspectorWorkerConfig,
    private readonly sources: InspectorSourceRegistry,
    private readonly network: NetworkDomain,
    private readonly realms: InspectorRealmRegistry,
    private readonly cordisDom: CordisDomBackend,
    private readonly cordisTrees: CordisRuntimeTreeReader,
    private readonly queries: InspectorQueryRouter,
  ) {
    this.cdpServer = new WebSocketServer({ noServer: true, maxPayload: config.maxSourceFrameBytes })
    this.ingestServer = new WebSocketServer({ noServer: true, maxPayload: config.maxSourceFrameBytes })
  }

  /**
   * Bind the loopback endpoint.
   * @returns The actual bound address and target id.
   */
  async start(): Promise<InspectorEndpointInfo> {
    let candidate = this.config.startPort
    while (true) {
      const server = this.createServer()
      this.server = server
      try {
        const address = await listen(server, candidate, this.config.host)
        server.on('error', () => {
          // An established server error is connection-local or reported by
          // the operating system; active sockets retain their own handlers.
        })
        return { host: this.config.host, port: address.port, targetId: this.config.targetId }
      } catch (error) {
        this.server = undefined
        if (!isAddressInUse(error) || candidate === 0) throw error
        if (candidate === 65_535) {
          throw new Error(`inspector: no available port from ${String(this.config.startPort)} through 65535`, {
            cause: error,
          })
        }
        candidate += 1
      }
    }
  }

  /** Stop admission, dispose CDP sessions, terminate sockets, and await server close. */
  async close(): Promise<void> {
    const server = this.requireServer()
    for (const [socket, session] of this.cdpSessions) {
      session.close()
      socket.terminate()
    }
    this.cdpSessions.clear()
    for (const [socket, connection] of this.ingestConnections) {
      this.sources.disconnect(connection, 'Client ingest endpoint stopped')
      socket.terminate()
    }
    this.ingestConnections.clear()
    await Promise.all([
      closeWebSocketServer(this.cdpServer),
      closeWebSocketServer(this.ingestServer),
      new Promise<void>((resolve) => {
        server.close(() => { resolve() })
        server.closeAllConnections()
      }),
    ])
  }

  private handleHttp(request: IncomingMessage, response: import('node:http').ServerResponse): void {
    const pathname = new URL(request.url ?? '/', 'http://inspector.invalid').pathname
    if (pathname === '/json' || pathname === '/json/list') {
      if (!this.cdpAuthorized(request)) {
        this.denyDiscovery(response)
        return
      }
      this.json(response, [this.target()])
      return
    }
    if (pathname === '/json/version') {
      if (!this.cdpAuthorized(request)) {
        this.denyDiscovery(response)
        return
      }
      this.json(response, {
        Browser: 'dsh-experimental-inspector/0',
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: this.cdpUrl(),
      })
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://inspector.invalid')
    } catch {
      socket.destroy()
      return
    }
    if (url.pathname === `/devtools/page/${this.config.targetId}`) {
      if (!this.cdpAuthorized(request)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      let clientSourceId: InspectorSourceId | undefined
      try {
        clientSourceId = readInspectorClientSelection(url)
      } catch (error) {
        void error // Invalid selectors must not open an unfiltered connection.
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      this.cdpServer.handleUpgrade(request, socket, head, (ws) => { this.acceptCdp(ws, clientSourceId) })
      return
    }
    if (url.pathname === '/ingest') {
      if (!this.authorizedClient(request)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      this.ingestServer.handleUpgrade(request, socket, head, (ws) => { this.acceptIngest(ws) })
      return
    }
    socket.destroy()
  }

  private acceptCdp(socket: WebSocket, clientSourceId: InspectorSourceId | undefined): void {
    const transport: CdpTransport = {
      send: (payload) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload))
      },
      close: () => { socket.close(1008, 'invalid CDP request') },
    }
    const target = { targetId: this.config.targetId, title: 'DeepSeek Harness Host' }
    const session = new CdpSession(
      transport,
      target,
      this.sources,
      this.network,
      this.realms,
      this.cordisDom,
      this.cordisTrees,
      clientSourceId,
    )
    this.cdpSessions.set(socket, session)
    socket.on('message', (data) => {
      try {
        session.receive(JSON.parse(rawText(data)) as unknown)
      } catch {
        socket.close(1008, 'CDP frame must be JSON')
      }
    })
    socket.once('close', () => {
      this.cdpSessions.delete(socket)
      session.close()
    })
    socket.on('error', () => {
      // The close event performs connection-owned cleanup.
    })
  }

  private acceptIngest(socket: WebSocket): void {
    const queryPeer = this.queries.open({
      send: (frame) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame))
      },
      close: (code, reason) => { socket.close(code, reason) },
    })
    const connection: SourceConnection = {
      kind: 'client',
      send: (frame: WorkerToSourceFrame) => {
        if (socket.readyState !== socket.OPEN) return
        socket.send(JSON.stringify(frame))
        if (frame.t === 'source/accepted') queryPeer.accept(frame.sourceId, frame.generation)
      },
      close: (code, reason) => { socket.close(code, reason.slice(0, 123)) },
    }
    this.ingestConnections.set(socket, connection)
    socket.on('message', (data) => {
      try {
        const value: unknown = JSON.parse(rawText(data))
        if (!queryPeer.receive(value)) this.sources.receive(connection, value)
      } catch {
        connection.close(1008, 'source frame must be JSON')
      }
    })
    socket.once('close', () => {
      this.ingestConnections.delete(socket)
      queryPeer.close()
      this.sources.disconnect(connection, 'Client source disconnected')
    })
    socket.on('error', () => {
      // The close event performs connection-owned cleanup.
    })
  }

  private authorizedClient(request: IncomingMessage): boolean {
    const protocols = (request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map(value => value.trim())
    if (!protocols.includes(this.config.clientToken)) return false
    const origin = request.headers.origin
    if (origin === undefined) return true
    if (this.config.clientOrigins.includes(origin)) return true
    try {
      const hostname = new URL(origin).hostname
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
    } catch {
      return false
    }
  }

  /**
   * Decide whether one request may reach the CDP surface (discovery and debugger attachment).
   *
   * Three independent checks, cheapest first: the per-run token (stops a local port scanner from
   * attaching), the `Host` header (stops a web page from reaching this port through a rebound DNS
   * name, where the URL would carry a foreign authority), and `Origin` (absent for the DevTools
   * frontend and for the Host proxy, present and attacker-controlled for any browser page).
   * @param request - The HTTP request or upgrade request being admitted.
   * @returns True only when all three checks pass.
   */
  private cdpAuthorized(request: IncomingMessage): boolean {
    const url = new URL(request.url ?? '/', 'http://inspector.invalid')
    if (!this.tokenAccepted(url.searchParams.get(CDP_TOKEN_QUERY))) return false
    if (!this.hostAccepted(request.headers.host)) return false
    return this.originAccepted(request.headers.origin)
  }

  private tokenAccepted(presented: string | null): boolean {
    if (presented === null || presented.length === 0) return false
    const expected = Buffer.from(this.config.clientToken, 'utf8')
    const actual = Buffer.from(presented, 'utf8')
    // timingSafeEqual throws on length mismatch, which would itself leak the token length.
    if (actual.length !== expected.length) return false
    return timingSafeEqual(actual, expected)
  }

  private hostAccepted(host: string | undefined): boolean {
    if (host === undefined) return false
    const hostname = host.startsWith('[')
      ? host.slice(0, host.indexOf(']') + 1)
      : host.split(':')[0] ?? ''
    if (hostname === '') return false
    if (hostname === this.config.host) return true
    return LOOPBACK_HOSTNAMES.includes(hostname.toLowerCase())
  }

  private originAccepted(origin: string | undefined): boolean {
    if (origin === undefined) return true
    if (this.config.clientOrigins.includes(origin)) return true
    try {
      return LOOPBACK_HOSTNAMES.includes(new URL(origin).hostname.toLowerCase())
    } catch {
      return false
    }
  }

  private denyDiscovery(response: import('node:http').ServerResponse): void {
    response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: 'inspector: CDP discovery requires the per-run token' }))
  }

  private target(): object {
    return {
      id: this.config.targetId,
      type: 'page',
      title: 'DeepSeek Harness Host',
      description: 'Experimental cross-realm Inspector target',
      url: 'dsh://host',
      webSocketDebuggerUrl: this.cdpUrl(),
      devtoolsFrontendUrl: `devtools://devtools/bundled/devtools_app.html?ws=${this.config.host}:${this.boundPort()}/devtools/page/${this.config.targetId}?${CDP_TOKEN_QUERY}=${encodeURIComponent(this.config.clientToken)}&panel=elements&noJavaScriptCompletion=true`,
    }
  }

  private cdpUrl(): string {
    return `ws://${this.config.host}:${String(this.boundPort())}/devtools/page/${this.config.targetId}`
      + `?${CDP_TOKEN_QUERY}=${encodeURIComponent(this.config.clientToken)}`
  }

  private boundPort(): number {
    const address = this.requireServer().address()
    if (address === null || typeof address === 'string') {
      throw new Error('inspector: endpoint is not bound to a TCP port')
    }
    return address.port
  }

  private createServer(): Server {
    const server = createServer((request, response) => { this.handleHttp(request, response) })
    server.on('upgrade', (request, socket, head) => { this.handleUpgrade(request, socket, head) })
    return server
  }

  private requireServer(): Server {
    if (this.server === undefined) throw new Error('inspector: endpoint is not started')
    return this.server
  }

  private json(response: import('node:http').ServerResponse, value: unknown): void {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(value))
  }
}

/** Hostnames a request may name while still counting as "this machine". */
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]', '::1']

function listen(server: Server, port: number, host: string): Promise<AddressInfo> {  return new Promise((resolve, reject) => {
  const finish = (): void => {
    server.off('error', onError)
    server.off('listening', onListening)
  }
  const onError = (error: Error): void => {
    finish()
    reject(error)
  }
  const onListening = (): void => {
    finish()
    const address = server.address()
    if (address === null || typeof address === 'string') {
      reject(new Error('inspector: endpoint did not bind a TCP port'))
      return
    }
    resolve(address)
  }
  server.once('error', onError)
  server.once('listening', onListening)
  server.listen(port, host)
})
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
}

function rawText(data: RawData): string {
  const bytes = data instanceof ArrayBuffer
    ? Buffer.from(new Uint8Array(data))
    : Array.isArray(data) ? Buffer.concat(data) : data
  return bytes.toString('utf8')
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => { resolve() })
  })
}
