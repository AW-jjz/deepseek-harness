/** The CDP surface admits only requests carrying the per-run token from this machine. */

import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { startInspector, type InspectorHandle } from '../src/host/bridge/controller.ts'

let inspector: InspectorHandle | undefined

afterEach(async () => {
  await inspector?.close()
  inspector = undefined
})

interface Probe {
  readonly status: number
  readonly body: string
}

/**
 * Issue one plain HTTP request with headers `fetch` refuses to set (Host, Origin).
 * @param port - Bound Inspector port.
 * @param path - Request path including any query string.
 * @param headers - Raw headers to send verbatim.
 * @returns The status code and body text.
 */
async function probe(port: number, path: string, headers: Record<string, string>): Promise<Probe> {
  return await new Promise<Probe>((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

describe('CDP discovery access control', () => {
  it('refuses discovery without the token, and refuses a foreign Host or Origin even with it', async () => {
    inspector = await startInspector({ port: 0, captureFetch: false })
    const port = Number(new URL(inspector.endpoint.httpUrl).port)
    const token = inspector.endpoint.client.protocol
    const authorized = `?token=${encodeURIComponent(token)}`

    const anonymous = await probe(port, '/json', { host: `127.0.0.1:${String(port)}` })
    expect(anonymous.status).toBe(403)
    expect(anonymous.body).toContain('requires the per-run token')

    const authorizedRequest = await probe(port, `/json${authorized}`, { host: `127.0.0.1:${String(port)}` })
    expect(authorizedRequest.status).toBe(200)

    // A web page reaching this port through a rebound DNS name carries that name in Host.
    const rebound = await probe(port, `/json${authorized}`, { host: `rebound.example:${String(port)}` })
    expect(rebound.status).toBe(403)

    // A browser always sends Origin; the DevTools frontend and the Host proxy never do.
    const crossSite = await probe(port, `/json${authorized}`, {
      host: `127.0.0.1:${String(port)}`,
      origin: 'http://evil.example',
    })
    expect(crossSite.status).toBe(403)

    const ownOrigin = await probe(port, `/json${authorized}`, {
      host: `127.0.0.1:${String(port)}`,
      origin: 'http://127.0.0.1:51729',
    })
    expect(ownOrigin.status).toBe(200)
  })
})
