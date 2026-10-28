/**
 * Startup integrity checks for the packaged Desktop runtime tree.
 *
 * The build seals every runtime file's byte count and SHA-256 into
 * `desktop-runtime.json`. Build scripts verified that inventory; the running
 * application did not, so a damaged or tampered runtime only surfaced as an
 * unrelated failure later. This module verifies the entry files the shell is
 * about to execute before any window opens, then verifies the whole tree in
 * the background and reports the result to diagnostics.
 *
 * @module runtime-integrity
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { DESKTOP_HOST_PACKAGE, DESKTOP_HOST_RUNTIME_FILES, DSH_PACKAGE } from './core-package-set.ts'
import {
  DesktopRuntimeIntegrityError,
  readDesktopRuntime,
  runtimePath,
  verifyDesktopRuntime,
  type DesktopRuntimeDescriptor,
} from './runtime-tree.ts'

/** Diagnostics record written under the Desktop cache directory after each check. */
export const RUNTIME_INTEGRITY_RECORD = 'runtime-integrity.json'

/** Outcome of one startup integrity pass. */
export interface RuntimeIntegrityReport {
  readonly ok: boolean
  /** Number of recorded files compared, or 0 when the pass failed early. */
  readonly files: number
  readonly durationMs: number
  /** Recorded path of the first mismatch, when one was identified. */
  readonly path?: string
  readonly message?: string
}

/** Critical entries verified before the shell creates a window. */
export interface CriticalRuntimeCheck {
  readonly descriptor: DesktopRuntimeDescriptor
  /** Slash-separated runtime paths that were compared. */
  readonly files: readonly string[]
}

/** Options for the background full-tree pass. */
export interface BackgroundIntegrityOptions {
  /** Packaged runtime root (`<app>/dsh`). */
  readonly root: string
  /** Directory that receives {@link RUNTIME_INTEGRITY_RECORD}; omitted in tests. */
  readonly recordDirectory?: string
  /** Target required of the descriptor; defaults to this process. */
  readonly target?: { platform: NodeJS.Platform; arch: string }
  /** Called once when the pass finds a mismatch. */
  readonly onFailure?: (report: RuntimeIntegrityReport) => void
}

/** Raised when a critical runtime entry is missing from the inventory or does not match it. */
export class RuntimeIntegrityError extends Error {
  /** Slash-separated runtime path that failed, when known. */
  readonly path: string | undefined

  /**
   * @param message - Failure explanation.
   * @param path - Slash-separated runtime path that failed.
   */
  constructor(message: string, path?: string) {
    super(message)
    this.name = 'RuntimeIntegrityError'
    this.path = path
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve the package entry files the shell or Host executes from a manifest.
 * Only `main` and `bin` are resolved: both are plain relative paths, while
 * conditional `exports` need a resolver the shell does not carry.
 * @param manifest - Installed package manifest.
 * @returns Package-relative entry paths, de-duplicated.
 */
function packageEntries(manifest: unknown): string[] {
  if (!record(manifest)) throw new RuntimeIntegrityError('desktop runtime: invalid package manifest')
  const entries = new Set<string>()
  if (typeof manifest.main === 'string' && manifest.main !== '') entries.add(manifest.main)
  if (typeof manifest.bin === 'string' && manifest.bin !== '') entries.add(manifest.bin)
  else if (record(manifest.bin)) {
    for (const value of Object.values(manifest.bin)) {
      if (typeof value === 'string' && value !== '') entries.add(value)
    }
  }
  return [...entries]
}

/**
 * List the runtime files the shell must trust before opening a window: the
 * two core manifests, their declared entry points, and the Desktop Host entry
 * files. Hashes of these files come from the sealed descriptor.
 * @param root - Packaged runtime root.
 * @returns Slash-separated runtime paths in a stable order.
 */
export function criticalRuntimeFiles(root: string): string[] {
  const files = new Set<string>()
  for (const name of [DSH_PACKAGE, DESKTOP_HOST_PACKAGE]) {
    const directory = `node_modules/${name}`
    const manifestPath = `${directory}/package.json`
    files.add(manifestPath)
    const manifest: unknown = JSON.parse(readFileSync(runtimePath(root, manifestPath), 'utf8'))
    for (const entry of packageEntries(manifest)) {
      const normalized = entry.replaceAll('\\', '/').replace(/^\.\//u, '')
      if (normalized === '' || normalized.startsWith('/') || normalized.includes('..')) {
        throw new RuntimeIntegrityError(`desktop runtime: invalid ${name} entry path ${JSON.stringify(entry)}`, manifestPath)
      }
      files.add(`${directory}/${normalized}`)
    }
  }
  for (const file of DESKTOP_HOST_RUNTIME_FILES) {
    files.add(`node_modules/${DESKTOP_HOST_PACKAGE}/${file}`)
  }
  return [...files].sort()
}

/**
 * Verify the descriptor and every critical entry synchronously, before the
 * shell creates a window. This is fail-closed: the caller refuses to start
 * when it throws.
 * @param root - Packaged runtime root.
 * @param target - Required platform and architecture; defaults to this process.
 * @returns The parsed descriptor and the compared paths.
 */
export function verifyCriticalRuntime(
  root: string,
  target: { platform: NodeJS.Platform; arch: string } = process,
): CriticalRuntimeCheck {
  const descriptor = readDesktopRuntime(root)
  if (descriptor.platform !== target.platform || descriptor.arch !== target.arch) {
    throw new RuntimeIntegrityError(
      `desktop runtime: descriptor targets ${descriptor.platform}-${descriptor.arch}, not ${target.platform}-${target.arch}`,
    )
  }
  const recorded = new Map(descriptor.files.map(entry => [entry.path, entry]))
  const files = criticalRuntimeFiles(root)
  for (const name of files) {
    const entry = recorded.get(name)
    if (entry === undefined) {
      throw new RuntimeIntegrityError(`desktop runtime: ${name} is missing from the sealed inventory`, name)
    }
    const body = readFileSync(runtimePath(root, name))
    if (body.byteLength !== entry.bytes
      || createHash('sha256').update(body).digest('hex') !== entry.sha256) {
      throw new RuntimeIntegrityError(`desktop runtime: ${name} does not match its recorded hash`, name)
    }
  }
  return { descriptor, files }
}

/**
 * Verify every recorded runtime file against its sealed bytes and permissions.
 * Never rejects: failures are reported, so a background caller can show one
 * diagnostic instead of handling errors at each call site.
 * @param root - Packaged runtime root.
 * @param target - Required platform and architecture; defaults to this process.
 * @returns The verification outcome.
 */
export async function verifyWholeRuntime(
  root: string,
  target: { platform: NodeJS.Platform; arch: string } = process,
): Promise<RuntimeIntegrityReport> {
  const started = performance.now()
  try {
    const descriptor = await verifyDesktopRuntime(root, undefined, target)
    return { ok: true, files: descriptor.files.length, durationMs: Math.round(performance.now() - started) }
  } catch (error: unknown) {
    return {
      ok: false,
      files: 0,
      durationMs: Math.round(performance.now() - started),
      ...(error instanceof DesktopRuntimeIntegrityError && error.path !== undefined ? { path: error.path } : {}),
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Run the full-tree pass and persist its outcome for diagnostics. The record
 * carries the failing path but no runtime content, so it is safe to attach to
 * a support bundle.
 * @param options - Runtime root, optional record directory, and failure callback.
 * @returns The verification outcome after the record write settles.
 */
export async function verifyRuntimeInBackground(options: BackgroundIntegrityOptions): Promise<RuntimeIntegrityReport> {
  const report = await verifyWholeRuntime(options.root, options.target)
  if (options.recordDirectory !== undefined) {
    await writeRuntimeIntegrityRecord(options.recordDirectory, report).catch((error: unknown) => {
      console.warn('desktop runtime integrity: the diagnostics record was not written', error)
    })
  }
  if (!report.ok) options.onFailure?.(report)
  return report
}

/**
 * Persist one integrity outcome beside the other Desktop cache diagnostics.
 * @param directory - Cache directory, normally `<userData>/cache`.
 * @param report - Outcome of the pass.
 * @returns Path of the written record.
 */
export async function writeRuntimeIntegrityRecord(
  directory: string,
  report: RuntimeIntegrityReport,
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, RUNTIME_INTEGRITY_RECORD)
  await writeFileAtomic(path, `${JSON.stringify({
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    ok: report.ok,
    files: report.files,
    durationMs: report.durationMs,
    ...(report.path === undefined ? {} : { path: report.path }),
    ...(report.message === undefined ? {} : { message: report.message }),
  }, undefined, 2)}\n`, { mode: 0o600 })
  return path
}
