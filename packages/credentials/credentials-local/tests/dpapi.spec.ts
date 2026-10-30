/** DPAPI envelope: the sealed-document half of the credentials store. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { decryptDocumentText, DPAPI_ENVELOPE_PREFIX, encryptDocumentText, isDpapiEnvelope } from '../src/dpapi.ts'
import { LocalCredentialProvider } from '../src/index.ts'

const SECRET_DOCUMENT = 'version: 1\nrefs:\n  DSH_CRED_TEST: super-secret-value\n'
const KEY = credentialRef('DSH_CRED_TEST')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-credentials-dpapi-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(config: ConstructorParameters<typeof LocalCredentialProvider>[1]): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, config)
  cleanups.push(async () => {
    await fiber.dispose()
  })
  await fiber
  return ctx
}

describe('isDpapiEnvelope', () => {
  it('recognizes the marker line and nothing else', () => {
    expect(isDpapiEnvelope(`${DPAPI_ENVELOPE_PREFIX}\n# note\nQUJD\n`)).toBe(true)
    expect(isDpapiEnvelope(SECRET_DOCUMENT)).toBe(false)
    // A document that merely mentions the marker in a comment is plaintext.
    expect(isDpapiEnvelope(`# ${DPAPI_ENVELOPE_PREFIX}\nversion: 1\n`)).toBe(false)
  })
})

describe('decryptDocumentText', () => {
  it('refuses a plaintext document instead of guessing at it', () => {
    expect(() => decryptDocumentText(SECRET_DOCUMENT)).toThrow(/not a DPAPI envelope/u)
  })

  it('refuses an envelope with no ciphertext', () => {
    expect(() => decryptDocumentText(`${DPAPI_ENVELOPE_PREFIX}\n# note\n`)).toThrow(/holds no ciphertext/u)
  })
})

describe.skipIf(process.platform !== 'win32')('DPAPI round trip', () => {
  // Each leg starts Windows PowerShell and loads System.Security: the first
  // call after boot costs seconds, which the 5 s default would call a failure.
  vi.setConfig({ testTimeout: 60_000 })

  it('restores the exact document text', async () => {
    const sealed = encryptDocumentText(SECRET_DOCUMENT)
    expect(isDpapiEnvelope(sealed)).toBe(true)
    expect(decryptDocumentText(sealed)).toBe(SECRET_DOCUMENT)
  })

  it('keeps the file a text document that no longer contains the secret', async () => {
    const sealed = encryptDocumentText(SECRET_DOCUMENT)
    // The envelope must round-trip through UTF-8 unchanged: the writer lock,
    // atomic replace and the watcher all treat this file as text.
    expect(Buffer.from(sealed, 'utf8').toString('utf8')).toBe(sealed)
    expect(sealed).not.toContain('super-secret-value')
    expect(sealed).toMatch(/^# dsh-dpapi:v1\n# /u)
  })

  it('fails closed on a tampered ciphertext', () => {
    const sealed = encryptDocumentText(SECRET_DOCUMENT)
    // Flip one character in the middle of the ciphertext. The first bytes of a
    // DPAPI blob are a header DPAPI tolerates changes in, so a flip near the
    // start would prove nothing about the sealed region.
    const payload = sealed.split('\n').slice(2).join('')
    const at = Math.floor(payload.length / 2)
    const tampered = payload.slice(0, at) + (payload.charAt(at) === 'A' ? 'B' : 'A') + payload.slice(at + 1)
    expect(() => decryptDocumentText(`${DPAPI_ENVELOPE_PREFIX}\n# note\n${tampered}\n`)).toThrow(/could not decrypt/u)
  })

  it('writes a sealed document when encrypt is on, and still serves the value', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false, encrypt: true })
    await ctx.credentials.set(KEY, 'super-secret-value')
    const onDisk = await readFile(path, 'utf8')
    expect(isDpapiEnvelope(onDisk)).toBe(true)
    expect(onDisk).not.toContain('super-secret-value')
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'super-secret-value', source: 'file' })
  })

  it('reads a sealed document even when the reader was configured without encrypt', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const writer = await boot({ path, watch: false, encrypt: true })
    await writer.credentials.set(KEY, 'super-secret-value')
    const reader = await boot({ path, watch: false })
    expect(await reader.credentials.resolve(KEY)).toEqual({ value: 'super-secret-value', source: 'file' })
  })

  it('leaves a plaintext document plaintext when encrypt is off', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    await ctx.credentials.set(KEY, 'plain-value')
    const onDisk = await readFile(path, 'utf8')
    expect(isDpapiEnvelope(onDisk)).toBe(false)
    expect(onDisk).toContain('plain-value')
  })

  it('fails boot loud when a sealed document cannot be unwrapped', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    // Valid marker, ciphertext that is not this account's: a sealed document
    // must never be mistaken for an empty store.
    await writeFile(path, `${DPAPI_ENVELOPE_PREFIX}\n# note\nQUJDRA==\n`, { mode: 0o600 })
    const ctx = new Context()
    await expect(ctx.plugin(LocalCredentialProvider, { path, watch: false })).rejects.toThrow(/could not decrypt/u)
  })
})
