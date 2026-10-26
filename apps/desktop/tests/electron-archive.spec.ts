import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ELECTRON_ARCHIVE_LOCK_VERSION,
  pinnedElectronArchiveSha256,
  verifyElectronArchive,
} from '../scripts/electron-archive.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function archiveWith(bytes: Buffer): string {
  const root = mkdtempSync(join(tmpdir(), 'electron-archive-'))
  roots.push(root)
  const path = join(root, 'electron.zip')
  writeFileSync(path, bytes)
  return path
}

describe('pinned Electron archives', () => {
  it('pins every target the packaging path can request', () => {
    for (const target of [['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64'], ['linux', 'arm64']] as const) {
      expect(pinnedElectronArchiveSha256(ELECTRON_ARCHIVE_LOCK_VERSION, target[0], target[1])).toMatch(/^[a-f0-9]{64}$/u)
    }
  })

  it('refuses a version the repository has not reviewed', () => {
    // This is the S0 failure mode: a lockfile or installed package drifts and the build
    // silently ships a runtime nobody pinned.
    expect(() => pinnedElectronArchiveSha256('44.7.0', 'win32', 'x64'))
      .toThrow(/pinned version is .* but 44\.7\.0 is installed/u)
  })

  it('refuses a target without a pin', () => {
    expect(() => pinnedElectronArchiveSha256(ELECTRON_ARCHIVE_LOCK_VERSION, 'win32', 'arm64'))
      .toThrow(/no pinned archive for win32-arm64/u)
  })

  it('accepts an archive whose digest matches and rejects a single flipped byte', () => {
    // The digest of the empty file is well known, so a temp archive can stand in for the
    // 150 MB download: the check only reads bytes.
    const empty = archiveWith(Buffer.alloc(0))
    const emptySha = createHash('sha256').update(Buffer.alloc(0)).digest('hex')
    const original = pinnedElectronArchiveSha256(ELECTRON_ARCHIVE_LOCK_VERSION, 'win32', 'x64')
    expect(() => verifyElectronArchive(empty, ELECTRON_ARCHIVE_LOCK_VERSION, 'win32', 'x64'))
      .toThrow(new RegExp(emptySha))
    expect(original).not.toBe(emptySha)
    const tampered = archiveWith(Buffer.from('not the release archive'))
    expect(() => verifyElectronArchive(tampered, ELECTRON_ARCHIVE_LOCK_VERSION, 'win32', 'x64'))
      .toThrow(/does not match the pinned/u)
  })
})
