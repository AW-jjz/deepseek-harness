/**
 * Fail when `pnpm-lock.yaml` is not the lockfile pnpm resolves from the
 * committed manifests.
 *
 * Every CI install passes `--frozen-lockfile`, which proves only that the bytes
 * it is handed can be installed. A lockfile edited to a different but still
 * resolvable graph — or one produced against another registry — installs
 * green while shipping a dependency tree no manifest implies. This gate re-runs
 * pnpm's own resolution (`install --lockfile-only`) and fails on any byte it
 * rewrites, then restores the committed bytes so a gate run never leaves a
 * dirty worktree behind.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pnpmInvocation } from './pnpm-invocation.ts'

const root = resolve(import.meta.dirname, '..')

const LOCKFILE = 'pnpm-lock.yaml'

/** How many differing lines a failure prints before it elides the rest. */
const SAMPLE_LIMIT = 12

/** Line-level shape of the difference between the committed and resolved lockfile. */
export interface LockfileDrift {
  /** True when both sides hold the same lines in the same multiset. */
  identical: boolean
  /** First differing lines that only the resolved lockfile contains. */
  added: string[]
  /** First differing lines that only the committed lockfile contains. */
  removed: string[]
  /** Count of lines only the resolved lockfile contains. */
  addedTotal: number
  /** Count of lines only the committed lockfile contains. */
  removedTotal: number
}

/** The filesystem and process effects one verification performs. */
export interface LockfileVerifierDependencies {
  /** Read the lockfile exactly as it sits in the worktree. */
  readLockfile: () => string
  /** Put the committed bytes back after pnpm rewrote them. */
  writeLockfile: (contents: string) => void
  /** Run `pnpm install --lockfile-only` in the repository root. */
  resolveLockfile: () => { status: number | null; stdout: string; stderr: string }
}

/** Outcome of one verification, already reduced to an exit code and its report. */
export interface LockfileVerification {
  /** 0 when pnpm reproduced the committed lockfile, 1 otherwise. */
  exitCode: number
  /** Present once the resolver returned; absent when pnpm itself failed. */
  drift: LockfileDrift | undefined
  /** Digest of the committed bytes, for the success report and the ledger. */
  digest: string
  /** Report lines the caller prints verbatim. */
  diagnostics: string[]
}

/**
 * Normalize line endings before comparing.
 *
 * `.gitattributes` pins `eol=lf`, so the worktree copy is LF, but `core.autocrlf`
 * can still hand a checkout CRLF. A line-ending-only difference is not drift.
 * @param text - Lockfile contents.
 * @returns The contents with CRLF collapsed to LF.
 */
function normalizeEol(text: string): string {
  return text.replaceAll('\r\n', '\n')
}

/**
 * Count how many times each line occurs.
 * @param text - Lockfile contents with normalized line endings.
 * @returns Occurrence count per distinct line.
 */
function lineCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of text.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1)
  return counts
}

/**
 * Compare two lockfiles as line multisets, sampling the first differences.
 *
 * A multiset comparison is exact for content while staying immune to line
 * reordering that YAML does not consider semantic; sampling keeps a large
 * rewrite from drowning the report.
 * @param before - Committed lockfile contents.
 * @param after - Lockfile contents pnpm rewrote.
 * @param sampleLimit - How many differing lines to keep per direction.
 * @returns The drift summary.
 */
export function summarizeLockfileDrift(
  before: string,
  after: string,
  sampleLimit = SAMPLE_LIMIT,
): LockfileDrift {
  const remaining = lineCounts(normalizeEol(before))
  const added: string[] = []
  let addedTotal = 0
  for (const line of normalizeEol(after).split('\n')) {
    const count = remaining.get(line) ?? 0
    if (count > 0) {
      remaining.set(line, count - 1)
      continue
    }
    addedTotal++
    if (added.length < sampleLimit) added.push(line)
  }
  const removed: string[] = []
  let removedTotal = 0
  for (const [line, count] of remaining) {
    if (count < 1) continue
    removedTotal += count
    if (removed.length < sampleLimit) removed.push(line)
  }
  return { identical: addedTotal === 0 && removedTotal === 0, added, removed, addedTotal, removedTotal }
}

/**
 * Digest the committed lockfile for the ledger and the success report.
 * @param contents - Lockfile contents.
 * @returns The SHA-256 hex digest.
 */
export function lockfileDigest(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

/**
 * Keep the tail of a failed resolver's output, where pnpm puts the reason.
 * @param output - Combined stdout and stderr.
 * @param limit - How many trailing lines to keep.
 * @returns The trailing lines.
 */
function outputTail(output: string, limit = SAMPLE_LIMIT): string[] {
  return output.split('\n')
    .map(line => line.trimEnd())
    .filter(line => line !== '')
    .slice(-limit)
}

/**
 * Run the resolution and decide whether the committed lockfile survived it.
 *
 * Restoration happens on drift, never on resolver failure: a failed resolution
 * leaves the file untouched, and rewriting it in that state would destroy the
 * only evidence of what the developer had.
 * @param dependencies - Filesystem and resolution effects.
 * @returns The exit code and its report lines.
 */
export function verifyLockfileImmutable(
  dependencies: LockfileVerifierDependencies,
): LockfileVerification {
  const before = dependencies.readLockfile()
  const digest = lockfileDigest(before)
  const resolution = dependencies.resolveLockfile()
  if (resolution.status !== 0) {
    return {
      exitCode: 1,
      drift: undefined,
      digest,
      diagnostics: [
        `pnpm install --lockfile-only exited with ${String(resolution.status ?? 'unknown')}; ${LOCKFILE} could not be verified.`,
        ...outputTail(`${resolution.stdout}\n${resolution.stderr}`),
      ],
    }
  }
  const drift = summarizeLockfileDrift(before, dependencies.readLockfile())
  if (drift.identical) return { exitCode: 0, drift, digest, diagnostics: [] }
  dependencies.writeLockfile(before)
  return {
    exitCode: 1,
    drift,
    digest,
    diagnostics: [
      `pnpm rewrote ${LOCKFILE} while resolving the committed manifests: +${String(drift.addedTotal)} / -${String(drift.removedTotal)} line(s).`,
      ...drift.removed.map(line => `  - ${line}`),
      ...drift.added.map(line => `  + ${line}`),
      drift.addedTotal > drift.added.length || drift.removedTotal > drift.removed.length
        ? `  … ${String(drift.addedTotal + drift.removedTotal - drift.added.length - drift.removed.length)} more differing line(s)`
        : undefined,
      `The committed bytes were restored (sha256 ${digest.slice(0, 16)}). Run \`pnpm install\` and commit the regenerated lockfile with the manifest change that requires it.`,
    ].filter((line): line is string => line !== undefined),
  }
}

/**
 * Recover the reason a spawn never produced output.
 *
 * `spawnSync` reports a failed exec through `error` while leaving the captured
 * streams empty, so the operating-system message is the only diagnosis.
 * @param result - Result of the failed spawn.
 * @returns The operating-system error message, or an empty string.
 */
function spawnFailure(result: { error?: Error }): string {
  return result.error?.message ?? ''
}

if (import.meta.main) {
  const lockfilePath = resolve(root, LOCKFILE)
  const verification = verifyLockfileImmutable({
    readLockfile: () => readFileSync(lockfilePath, 'utf8'),
    writeLockfile: (contents) => { writeFileSync(lockfilePath, contents) },
    resolveLockfile: () => {
      const { command, args } = pnpmInvocation(['install', '--lockfile-only', '--ignore-scripts'])
      const result = spawnSync(command, args, {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
      return { status: result.status, stdout: result.stdout, stderr: result.stderr || spawnFailure(result) }
    },
  })

  if (verification.exitCode !== 0) {
    console.error('verify-lockfile-immutable: the lockfile does not survive a fresh resolution.')
    for (const line of verification.diagnostics) console.error(line)
    process.exit(verification.exitCode)
  }

  console.log(`verify-lockfile-immutable: pnpm reproduced ${LOCKFILE} unchanged (sha256 ${verification.digest.slice(0, 16)}).`)
}
