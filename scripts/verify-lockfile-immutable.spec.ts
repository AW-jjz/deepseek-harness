/**
 * Drift detection and restoration coverage for `verify-lockfile-immutable`: an
 * unchanged resolution passes silently, a rewritten lockfile fails and puts the
 * committed bytes back, and a resolver failure never rewrites the file it could
 * not verify.
 */

import { describe, expect, it } from 'vitest'
import {
  lockfileDigest,
  summarizeLockfileDrift,
  verifyLockfileImmutable,
  type LockfileVerifierDependencies,
} from './verify-lockfile-immutable.ts'

const COMMITTED = [
  "lockfileVersion: '9.0'",
  '',
  'importers:',
  '',
  '  .:',
  '    dependencies:',
  '      yauzl:',
  '        specifier: 3.4.0',
  '        version: 3.4.0',
  '',
].join('\n')

/**
 * Build a dependency set around one in-memory lockfile, recording every write.
 * @param after - Contents the resolver leaves behind, or `undefined` to fail resolution.
 * @returns The dependencies plus the write log.
 */
function harness(after: string | undefined): {
  dependencies: LockfileVerifierDependencies
  writes: string[]
  resolutions: number
} {
  const writes: string[] = []
  const state = { resolutions: 0 }
  const dependencies: LockfileVerifierDependencies = {
    readLockfile: () => (state.resolutions === 0 ? COMMITTED : after ?? COMMITTED),
    writeLockfile: (contents) => { writes.push(contents) },
    resolveLockfile: () => {
      state.resolutions++
      if (after === undefined) return { status: 1, stdout: '', stderr: 'ERR_PNPM_META_FETCH_FAIL\n  GET https://registry.example/yauzl: ETIMEDOUT' }
      return { status: 0, stdout: 'Done in 2s', stderr: '' }
    },
  }
  return {
    dependencies,
    writes,
    get resolutions() { return state.resolutions },
  }
}

describe('summarizeLockfileDrift', () => {
  it('reports no drift for identical content and for a line-ending-only difference', () => {
    expect(summarizeLockfileDrift(COMMITTED, COMMITTED).identical).toBe(true)
    expect(summarizeLockfileDrift(COMMITTED, COMMITTED.replaceAll('\n', '\r\n')).identical).toBe(true)
  })

  it('locates a resolution change as one removed and one added line', () => {
    const rewritten = COMMITTED.replace('version: 3.4.0', 'version: 3.6.0')
    const drift = summarizeLockfileDrift(COMMITTED, rewritten)
    expect(drift.identical).toBe(false)
    expect(drift.removedTotal).toBe(1)
    expect(drift.addedTotal).toBe(1)
    expect(drift.removed).toEqual(['        version: 3.4.0'])
    expect(drift.added).toEqual(['        version: 3.6.0'])
  })

  it('counts duplicate lines by occurrence rather than by presence', () => {
    const drift = summarizeLockfileDrift('a\n\nb\n', 'a\n\n\nb\n')
    expect(drift.identical).toBe(false)
    expect(drift.addedTotal).toBe(1)
    expect(drift.removedTotal).toBe(0)
    expect(drift.added).toEqual([''])
  })

  it('caps the samples while still counting every differing line', () => {
    const drift = summarizeLockfileDrift('', Array.from({ length: 40 }, (_, index) => `line ${String(index)}`).join('\n'), 3)
    expect(drift.addedTotal).toBe(40)
    expect(drift.added).toHaveLength(3)
  })
})

describe('verifyLockfileImmutable', () => {
  it('passes without writing when pnpm reproduces the committed lockfile', () => {
    const subject = harness(COMMITTED)
    const verification = verifyLockfileImmutable(subject.dependencies)
    expect(verification.exitCode).toBe(0)
    expect(verification.drift?.identical).toBe(true)
    expect(subject.writes).toEqual([])
    expect(verification.digest).toBe(lockfileDigest(COMMITTED))
  })

  it('fails and restores the committed bytes when pnpm rewrites the lockfile', () => {
    const subject = harness(COMMITTED.replace('version: 3.4.0', 'version: 3.6.0'))
    const verification = verifyLockfileImmutable(subject.dependencies)
    expect(verification.exitCode).toBe(1)
    expect(subject.writes).toEqual([COMMITTED])
    expect(verification.diagnostics[0]).toContain('+1 / -1')
    expect(verification.diagnostics.join('\n')).toContain('restored')
  })

  it('fails without touching the file when the resolution itself fails', () => {
    const subject = harness(undefined)
    const verification = verifyLockfileImmutable(subject.dependencies)
    expect(verification.exitCode).toBe(1)
    expect(verification.drift).toBeUndefined()
    expect(subject.writes).toEqual([])
    expect(verification.diagnostics.join('\n')).toContain('ETIMEDOUT')
  })
})
