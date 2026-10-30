/**
 * Windows DPAPI envelope for the credentials document.
 *
 * A DACL keeps other OS users out of `.credentials.yaml`; it cannot keep out a
 * process running as the same user, and that is the exposure an injected agent
 * command lives in. DPAPI closes that half: the document is protected with the
 * current user's machine-derived key, so the bytes on disk are useless to a
 * process that cannot impersonate that user.
 *
 * The envelope is deliberately *text*: the ciphertext travels as base64 under a
 * comment header, so the file stays a readable text document for every other
 * tool in this package (atomic writes, the writer lock, the watcher's
 * change detection) and no binary mode has to be threaded through them.
 *
 * Tradeoffs this module does not hide, and which is why encryption is opt-in
 * rather than implicit:
 *
 * - DPAPI `CurrentUser` binds the document to one Windows account on one
 *   machine. A portable install copied to another machine, or opened under a
 *   different account, cannot decrypt it — those credentials must be re-entered.
 * - DPAPI `LocalMachine` would keep the document portable but is decryptable by
 *   every local user, which is exactly the DACL guarantee that already exists
 *   and adds nothing. It is not offered.
 */

import { spawnSync } from 'node:child_process'

/** First line of an encrypted document; also the version marker. */
export const DPAPI_ENVELOPE_PREFIX = '# dsh-dpapi:v1'

/** Second line, so a reader who finds the file knows what produced it. */
const DPAPI_ENVELOPE_NOTE = '# protected with Windows DPAPI (CurrentUser scope); plaintext is never written to this file'

/** Base64 line width in the envelope; 76 keeps the document diff-friendly. */
const BASE64_LINE_WIDTH = 76

/**
 * The PowerShell programs this module runs. Both read base64 from stdin and
 * write base64 to stdout: the path never appears on a command line, and the
 * plaintext never reaches a temporary file.
 */
const PROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security',
  '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd())',
  "$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser')",
  '[Console]::Out.Write([Convert]::ToBase64String($p))',
].join('\n')

const UNPROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security',
  '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd())',
  "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')",
  '[Console]::Out.Write([Convert]::ToBase64String($p))',
].join('\n')

/**
 * How long one DPAPI round trip may take. It is two PowerShell starts (the
 * shell plus the assembly load), not a network call: a minute means the OS is
 * wedged, and waiting longer only delays the failure the caller must see.
 */
const DPAPI_TIMEOUT_MS = 60_000

/**
 * Whether a document is a DPAPI envelope rather than plaintext YAML.
 * @param text - document text as read from disk.
 * @returns true when the first line is the envelope marker.
 */
export function isDpapiEnvelope(text: string): boolean {
  return text.startsWith(`${DPAPI_ENVELOPE_PREFIX}\n`)
}

/**
 * Run one DPAPI program, turning every failure into an error that names the
 * operation but never the payload.
 * @param script - the PowerShell program to run.
 * @param input - base64 fed to its stdin.
 * @param what - operation name for the error message.
 * @returns its stdout.
 */
function runDpapi(script: string, input: string, what: string): string {
  if (process.platform !== 'win32') {
    throw new Error(`credentials-local: cannot ${what} the document: DPAPI exists only on Windows`)
  }
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: DPAPI_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error !== undefined) throw result.error
  const out = result.stdout.trim()
  if (result.status !== 0 || out === '') {
    // PowerShell echoes a multi-line exception block, localized and possibly
    // mojibake in a redirected pipe. Keep one short line of it: enough to tell
    // "wrong account or machine" from "this file is damaged", nothing more.
    const detail = result.stderr.replace(/\s+/gu, ' ').trim().slice(0, 200)
    throw new Error(
      `credentials-local: could not ${what} the document with DPAPI: ${detail === '' ? `exit ${String(result.status)}` : detail}`,
    )
  }
  return out
}

/**
 * Wrap plaintext document text in a DPAPI envelope.
 * @param plaintext - the document as this provider renders it.
 * @returns the envelope text to write to disk.
 * @throws when the platform cannot perform DPAPI protection.
 */
export function encryptDocumentText(plaintext: string): string {
  const sealed = runDpapi(PROTECT_SCRIPT, Buffer.from(plaintext, 'utf8').toString('base64'), 'encrypt')
  const lines: string[] = []
  for (let at = 0; at < sealed.length; at += BASE64_LINE_WIDTH) {
    lines.push(sealed.slice(at, at + BASE64_LINE_WIDTH))
  }
  return `${DPAPI_ENVELOPE_PREFIX}\n${DPAPI_ENVELOPE_NOTE}\n${lines.join('\n')}\n`
}

/**
 * Unwrap a DPAPI envelope back to plaintext.
 * @param text - the document as read from disk; must be an envelope.
 * @returns the plaintext document.
 * @throws when the envelope is malformed, was written under another account or
 * machine, or the platform cannot perform DPAPI unprotection.
 */
export function decryptDocumentText(text: string): string {
  if (!isDpapiEnvelope(text)) {
    throw new Error('credentials-local: the document is not a DPAPI envelope')
  }
  // Skip the marker and the note; every remaining line is base64.
  const payload = text
    .split('\n')
    .slice(2)
    .filter(line => line !== '' && !line.startsWith('#'))
    .join('')
  if (payload === '') throw new Error('credentials-local: the DPAPI envelope holds no ciphertext')
  // Base64 on both legs of the round trip: a pipe adds its own trailing
  // newline, and the document text must come back byte for byte.
  return Buffer.from(runDpapi(UNPROTECT_SCRIPT, payload, 'decrypt'), 'base64').toString('utf8')
}
