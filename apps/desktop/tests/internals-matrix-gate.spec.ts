import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { shouldExposeInternals } from '../src/host-process.ts'
import {
  INTERNALS_MATRIX, addonCoversElectron, assertInternalsMatrixGate, evaluateInternalsMatrixGate,
  normalizeElectronVersion, type InternalsMatrix,
} from '../src/internals-matrix.ts'

const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')

/** Electron the desktop package declares, which provenance requires node_modules to match. */
function declaredElectron(): string {
  const manifest = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>
  }
  const declared = manifest.devDependencies?.electron
  if (declared === undefined) throw new Error('apps/desktop/package.json declares no Electron version')
  return declared
}

/** Version the Electron archive lock pins; prepare-runtime refuses an archive that does not match. */
function archiveLockElectron(): string {
  const lock = JSON.parse(readFileSync(join(APP_ROOT, 'scripts', 'electron-archive-lock.json'), 'utf8')) as {
    version?: string
  }
  if (lock.version === undefined) throw new Error('electron-archive-lock.json carries no version')
  return lock.version
}

/** Version the workspace lockfile actually resolves for the addon the matrix describes. */
function lockedAddonVersion(): string {
  const lock = readFileSync(join(REPOSITORY_ROOT, 'pnpm-lock.yaml'), 'utf8')
  const match = /^ {2}node-addon-require-builtin@(\S+):$/mu.exec(lock)
  if (match?.[1] === undefined) throw new Error('pnpm-lock.yaml resolves no node-addon-require-builtin')
  return match[1]
}

describe('internals matrix gate', () => {
  it('fails only when the Host drops the flag and the addon rejects the pin', () => {
    const verdict = evaluateInternalsMatrixGate({ electronVersion: '44.9.3', exposesInternals: false })
    expect(verdict.fatal).toBe(true)
    expect(verdict.addonCoversElectron).toBe(false)
    // Both ways out are named: the message is the only thing a failed build shows.
    expect(verdict.reason).toContain('without --expose-internals')
    expect(verdict.reason).toContain('host-process.ts')
    expect(verdict.reason).toContain('pin an addon release')
  })

  it('passes when the flag carries internals, and says which leg is doing the work', () => {
    const verdict = evaluateInternalsMatrixGate({ electronVersion: '44.9.3', exposesInternals: true })
    expect(verdict.fatal).toBe(false)
    expect(verdict.addonCoversElectron).toBe(false)
    expect(verdict.reason).toContain('--expose-internals')
  })

  it('passes without the flag once the addon covers the pin', () => {
    const matrix: InternalsMatrix = { addonVersion: '9.9.9', electronVersions: ['44.9.3'] }
    const verdict = evaluateInternalsMatrixGate({ electronVersion: '44.9.3', exposesInternals: false, matrix })
    expect(verdict).toMatchObject({ fatal: false, addonCoversElectron: true })
    expect(verdict.reason).toContain('node-addon-require-builtin@9.9.9')
  })

  it('treats an empty matrix as accepting nothing, so the flag becomes mandatory', () => {
    const verdict = evaluateInternalsMatrixGate({
      electronVersion: '44.9.3', exposesInternals: false, matrix: { addonVersion: '0.0.0', electronVersions: [] },
    })
    expect(verdict.fatal).toBe(true)
  })

  it('throws from the packaging entry point instead of returning a fatal verdict', () => {
    expect(() => assertInternalsMatrixGate({ electronVersion: '44.9.3', exposesInternals: false }))
      .toThrow(/desktop internals matrix: .*without --expose-internals/u)
    expect(assertInternalsMatrixGate({ electronVersion: '44.9.3', exposesInternals: true }).fatal).toBe(false)
  })
})

describe('electron version identity', () => {
  it('ignores a leading v and build metadata but keeps a prerelease', () => {
    expect(normalizeElectronVersion(' v44.9.3+build.7 ')).toBe('44.9.3')
    expect(normalizeElectronVersion('45.0.0-alpha.6')).toBe('45.0.0-alpha.6')
  })

  it('matches by exact release, so a patch outside the matrix is not covered', () => {
    expect(addonCoversElectron('44.7.0')).toBe(true)
    expect(addonCoversElectron('v44.7.0+build')).toBe(true)
    expect(addonCoversElectron('44.9.3')).toBe(false)
    // The matrix lists the alpha of 45, which says nothing about the 45 release itself.
    expect(addonCoversElectron('45.0.0-alpha.6')).toBe(true)
    expect(addonCoversElectron('45.0.0')).toBe(false)
  })
})

describe('the shipped matrix against this checkout', () => {
  it('keeps the declared and archived Electron pins identical', () => {
    expect(declaredElectron()).toBe(archiveLockElectron())
  })

  it('describes the addon version the lockfile resolves', () => {
    // A bumped addon without a re-checked matrix would otherwise judge new binaries against an
    // old published list, which is exactly the mistake this gate exists to catch.
    expect(lockedAddonVersion()).toBe(INTERNALS_MATRIX.addonVersion)
  })

  it('starts the Host with the flag under the default decision, and only the explicit opt-out drops it', () => {
    expect(shouldExposeInternals({})).toBe(true)
    expect(shouldExposeInternals({ DSH_EXPOSE_INTERNALS: '1' })).toBe(true)
    expect(shouldExposeInternals({ DSH_EXPOSE_INTERNALS: '0' })).toBe(false)
  })

  it('lets this checkout package: the default decision carries internals for the pinned Electron', () => {
    const electronVersion = declaredElectron()
    const verdict = assertInternalsMatrixGate({ electronVersion, exposesInternals: shouldExposeInternals({}) })
    expect(verdict.fatal).toBe(false)
    // The verdict must agree with the matrix, whichever way that goes after an addon update.
    expect(verdict.addonCoversElectron).toBe(addonCoversElectron(electronVersion))
  })
})
