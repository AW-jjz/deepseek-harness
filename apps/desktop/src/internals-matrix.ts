/**
 * The R-16 internals bridge matrix, and the static gate that refuses a build whose only
 * internals path is the addon leg that cannot serve this Electron.
 *
 * `node-addon-require-builtin@0.1.9` publishes an Electron fingerprint matrix that does not
 * include the Electron this desktop pins, so the Host starts with `--expose-internals` and
 * `packages/boot/app-boot/src/profile-resolution/resolver.ts` resolves internals through the
 * flag leg. The addon stays installed for plain-Node consumers whose fingerprint it does cover.
 *
 * That pairing is what makes a flagless start fatal rather than degraded: the flag is the
 * working leg and the addon is the dead one. Nothing about the source encodes the pairing — a
 * one-line change to the default in `host-process.ts` would ship an installer that cannot boot,
 * and the only signal would be a user's first launch. This module turns "flag off on a pin the
 * addon rejects" into a build failure, which is the gate the v8.1 review asked for, restated for
 * the flag-first architecture: fail when the Host does not pass the flag *and* the addon rejects
 * the pin, and only then.
 *
 * The matrix below is data about a published addon, not a preference. Bumping the addon without
 * re-checking it is caught by `internals-matrix-gate.spec.ts`, which compares its version against
 * the one the lockfile resolves.
 */

/** The addon release whose published electron matrix the entries below describe. */
export const INTERNALS_ADDON_VERSION = '0.1.9'

/** Electron versions `node-addon-require-builtin@0.1.9` accepts, as published by the addon. */
export const INTERNALS_ADDON_ELECTRON_MATRIX = [
  '43.0.0',
  '44.0.0',
  '44.7.0',
  '45.0.0-alpha.6',
] as const

/** One addon release and the Electron versions its native binaries accept. */
export interface InternalsMatrix {
  readonly addonVersion: string
  readonly electronVersions: readonly string[]
}

/** The matrix this build ships against. */
export const INTERNALS_MATRIX: InternalsMatrix = {
  addonVersion: INTERNALS_ADDON_VERSION,
  electronVersions: INTERNALS_ADDON_ELECTRON_MATRIX,
}

/** Everything the gate needs to decide, all of it known before packaging starts. */
export interface InternalsMatrixGateInput {
  /** Electron version this build pins, as the packaging provenance recorded it. */
  readonly electronVersion: string
  /** Whether the Host child is started with `--expose-internals` under the default decision. */
  readonly exposesInternals: boolean
  /** Matrix to judge against; defaults to the shipped one. */
  readonly matrix?: InternalsMatrix
}

/** The gate's answer, including why, so a packaging log line can quote it. */
export interface InternalsMatrixVerdict {
  /** True when neither internals path can serve this Electron. */
  readonly fatal: boolean
  /** Whether the addon's published matrix lists this Electron version. */
  readonly addonCoversElectron: boolean
  /** One sentence naming the facts and, when fatal, both ways out. */
  readonly reason: string
}

/**
 * Reduce an Electron version to the form the addon's matrix is written in: no leading `v`, no
 * build metadata, whitespace trimmed. A prerelease stays part of the identity, because the
 * addon ships a binary per release and `45.0.0-alpha.6` says nothing about `45.0.0`.
 * @param version - Version string from a manifest or a runtime probe.
 * @returns The comparable form.
 */
export function normalizeElectronVersion(version: string): string {
  const trimmed = version.trim().replace(/^v/u, '')
  const plus = trimmed.indexOf('+')
  return plus === -1 ? trimmed : trimmed.slice(0, plus)
}

/**
 * Judge whether the addon accepts an Electron version, by exact membership rather than semver
 * range: the matrix lists releases whose fingerprint was built and tested, and a patch release
 * outside the list is exactly the case that fails today.
 * @param electronVersion - Electron version this build pins.
 * @param matrix - Matrix to consult; defaults to the shipped one.
 * @returns True when the matrix lists this exact release.
 */
export function addonCoversElectron(
  electronVersion: string, matrix: InternalsMatrix = INTERNALS_MATRIX,
): boolean {
  const wanted = normalizeElectronVersion(electronVersion)
  return matrix.electronVersions.some(entry => normalizeElectronVersion(entry) === wanted)
}

/**
 * Decide the gate. The combination is fatal only when the flag is absent and the addon rejects
 * the pin: with the flag the internals resolve without the addon, and with a covering addon the
 * flag is unnecessary. Everything else is a build that can start.
 * @param input - Electron pin, flag decision and matrix.
 * @returns The verdict, including a sentence for the packaging log.
 */
export function evaluateInternalsMatrixGate(input: InternalsMatrixGateInput): InternalsMatrixVerdict {
  const matrix = input.matrix ?? INTERNALS_MATRIX
  const electron = normalizeElectronVersion(input.electronVersion)
  const addonCoversElectronNow = addonCoversElectron(electron, matrix)
  const addon = `node-addon-require-builtin@${matrix.addonVersion}`
  if (addonCoversElectronNow) {
    return {
      fatal: false,
      addonCoversElectron: true,
      reason: `${addon} accepts Electron ${electron}; the internals flag is not required for this pin`,
    }
  }
  if (input.exposesInternals) {
    return {
      fatal: false,
      addonCoversElectron: false,
      reason: `Electron ${electron} is outside the ${addon} matrix (${matrix.electronVersions.join(' / ')}); `
        + 'the Host starts with --expose-internals, which carries internals without the addon',
    }
  }
  return {
    fatal: true,
    addonCoversElectron: false,
    reason: `the Host would start without --expose-internals on Electron ${electron}, and ${addon} `
      + `accepts only ${matrix.electronVersions.join(' / ')}; restore the flag in `
      + 'apps/desktop/src/host-process.ts or pin an addon release whose matrix covers this Electron',
  }
}

/**
 * The gate as packaging calls it: throw rather than return, so the build stops before any
 * artifact exists.
 * @param input - Electron pin, flag decision and matrix.
 * @returns The non-fatal verdict, for a log line.
 */
export function assertInternalsMatrixGate(input: InternalsMatrixGateInput): InternalsMatrixVerdict {
  const verdict = evaluateInternalsMatrixGate(input)
  if (verdict.fatal) throw new Error(`desktop internals matrix: ${verdict.reason}`)
  return verdict
}
