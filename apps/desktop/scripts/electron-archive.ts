/** Pin the Electron release archives a build may unpack, independent of the download origin. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import lock from './electron-archive-lock.json' with { type: 'json' }

/** The version every pinned hash belongs to. */
export const ELECTRON_ARCHIVE_LOCK_VERSION: string = lock.version

/**
 * Look up the pinned sha256 for one target.
 *
 * A version mismatch is a hard failure rather than a warning: `@electron/get` verifies a
 * download against the checksums served beside it, which only proves the bytes match
 * whatever that host currently publishes. Pinning here is what makes the packaged runtime
 * auditable and what stops a silent version drift like the one that shipped the S0 build.
 * @param version - Electron version recorded by the installed package.
 * @param platform - Target Node.js platform.
 * @param arch - Target architecture.
 * @returns The expected lowercase hex digest.
 * @throws When the installed version is not the pinned one, or the target has no entry.
 */
export function pinnedElectronArchiveSha256(version: string, platform: string, arch: string): string {
  if (version !== lock.version) {
    throw new Error(`desktop electron lock: pinned version is ${lock.version} but ${version} is installed;`
      + ' update apps/desktop/scripts/electron-archive-lock.json deliberately when bumping Electron')
  }
  const key = `${platform}-${arch}`
  const digest = (lock.targets as Record<string, string | undefined>)[key]
  if (digest === undefined) throw new Error(`desktop electron lock: no pinned archive for ${key}`)
  return digest
}

/**
 * Verify one downloaded archive against its pin.
 * @param archive - Path to the downloaded release archive.
 * @param version - Electron version the build expects.
 * @param platform - Target Node.js platform.
 * @param arch - Target architecture.
 * @throws When the digest differs; the caller must not unpack an unverified archive.
 */
export function verifyElectronArchive(archive: string, version: string, platform: string, arch: string): void {
  const expected = pinnedElectronArchiveSha256(version, platform, arch)
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex')
  if (actual !== expected) {
    throw new Error(`desktop electron archive: sha256 ${actual} does not match the pinned ${expected}`
      + ` (${platform}-${arch} ${version})`)
  }
}
