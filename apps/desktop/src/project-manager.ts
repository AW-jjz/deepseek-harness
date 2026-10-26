/** Desktop profile initialization and native recovery. */

import {
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  closeSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { uptime } from 'node:os'
import { join } from 'node:path'
import {
  DESKTOP_HOST_PACKAGE,
  desktopCorePackageOverrides,
  verifyDesktopCorePackageSet,
} from './core-package-set.ts'
import type { DesktopPaths } from './paths.ts'
import type { DesktopRelease } from './release.ts'
import { readDesktopRuntime } from './runtime-tree.ts'
import { initProfile, removeLinkProjections, sanitizeProfile } from '@deepseek-ai/dsh-app-boot'
import { PROFILE_TEMPLATES, type ProfileTemplate } from '@deepseek-ai/dsh-official-bundles'

const PROJECT_NAME = '@deepseek-ai/dsh-desktop-runtime'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const CORE_BUILD_PACKAGE = '@deepseek-ai/dsh-subprocess-local'

/** A lock younger than this is trusted even when its recorded owner looks dead. */
const LOCK_MIN_STALE_AGE_MS = 2_000

/** One profile lock record: who holds it, and which boot wrote it. */
interface ProfileLockOwner {
  readonly pid: number
  readonly token: string
  /** Machine boot time in epoch milliseconds; a lock written before a reboot cannot be live. */
  readonly bootId: number
  /** File age source, so a very fresh lock is never taken over on a PID race. */
  readonly ageMs: number
}

/** Machine boot time in epoch milliseconds, stable for the lifetime of one boot. */
function machineBootId(): number {
  return Math.round(Date.now() - uptime() * 1_000)
}

/**
 * Read one lock record.
 * @param path - Lock file to read.
 * @returns The owner, or undefined when the file is unreadable or malformed.
 */
function readLockOwner(path: string): ProfileLockOwner | undefined {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return undefined }
  const ageMs = (() => { try { return Date.now() - lstatSync(path).mtimeMs } catch { return 0 } })()
  const trimmed = raw.trim()
  // Locks written before the record carried a token hold a bare pid; keep judging them the
  // same way so an upgrade does not turn an existing live lock into a takeover target.
  if (/^\d+$/u.test(trimmed)) {
    const pid = Number(trimmed)
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
    return { pid, token: `legacy:${trimmed}`, bootId: 0, ageMs }
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0) return undefined
    if (typeof record.token !== 'string' || record.token === '') return undefined
    const bootId = typeof record.bootId === 'number' ? record.bootId : 0
    return { pid: record.pid, token: record.token, bootId, ageMs }
  } catch { return undefined }
}

/**
 * Whether a lock holder is still running.
 *
 * A PID alone is not identity: after a crash and reboot the number can belong to a
 * different process. A record written during an earlier boot is therefore always stale.
 * A record we wrote ourselves is additionally trusted for its first moments, so a
 * simultaneous start cannot take over a lock whose owner is still booting.
 * @param owner - Lock record to judge.
 * @returns true while the recorded owner may still hold the profile.
 */
function isLockOwnerLive(owner: ProfileLockOwner): boolean {
  if (owner.bootId !== 0 && owner.ageMs < LOCK_MIN_STALE_AGE_MS) return true
  if (owner.bootId !== 0 && Math.abs(owner.bootId - machineBootId()) > 60_000) return false
  try {
    process.kill(owner.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Create the profile lock or take over a provably stale one.
 *
 * The takeover is a rename of the exact lock that was judged stale, so two contenders
 * cannot both claim it and neither can delete a lock another process just created. The
 * winner writes its own token and later removes the file only while that token is still
 * its own.
 * @param lockPath - Lock file path under the real profile directory.
 * @returns The open descriptor holding the new lock, plus its token.
 * @throws When another live operation holds the profile.
 */
function acquireProfileLock(lockPath: string): { descriptor: number; token: string } {
  const token = randomUUID()
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600)
      writeSync(descriptor, JSON.stringify({ pid: process.pid, token, bootId: machineBootId() }))
      fsyncSync(descriptor)
      return { descriptor, token }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const lock = lstatSync(lockPath)
      if (lock.isSymbolicLink() || !lock.isFile()) throw new Error('desktop project: profile lock is not a regular file')
      const owner = readLockOwner(lockPath)
      // An unreadable record stays fail-closed: guessing here is how a profile gets
      // corrupted by two writers, and the message tells the user what to do.
      if (owner === undefined) {
        throw new Error('desktop project: another profile operation is active (unreadable lock; remove it if no operation is running)')
      }
      if (isLockOwnerLive(owner)) throw new Error('desktop project: another profile operation is active')
      // Rename is atomic: exactly one contender moves this inode out of the way.
      const quarantine = `${lockPath}.stale-${randomUUID()}`
      try {
        renameSync(lockPath, quarantine)
      } catch (renameError) {
        // Someone else already took it over; retry creation against the new state.
        if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw renameError
      }
      const moved = readLockOwner(quarantine)
      if (moved !== undefined && moved.token !== owner.token) {
        // The inode changed between the check and the rename: put nothing back, keep the
        // displaced record for inspection and let the live owner finish.
        throw new Error('desktop project: another profile operation is active')
      }
      unlinkSync(quarantine)
    }
  }
  throw new Error('desktop project: another profile operation is active')
}
const WEB_PROFILE = PROFILE_TEMPLATES.web as ProfileTemplate
const WORKSPACE_SETTINGS = 'nodeLinker: hoisted\nautoInstallPeers: false\n'
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 })
}

function workspaceFile(overrides: Readonly<Record<string, string>> = {}): string {
  const entries = Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))
  const overrideSection = entries.length === 0
    ? ''
    : `overrides:\n${entries.map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`).join('\n')}\n`
  if (entries.length === 0) return `packages:\n  - .\n\n${WORKSPACE_SETTINGS}`
  const coreBuildSpec = overrides[CORE_BUILD_PACKAGE]
  const coreBuildKey = coreBuildSpec === undefined
    ? CORE_BUILD_PACKAGE
    : `${CORE_BUILD_PACKAGE}@${coreBuildSpec.replace('file:./', 'file:')}`
  return `packages:\n  - .\n\n${overrideSection}${WORKSPACE_SETTINGS}allowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  ${JSON.stringify(coreBuildKey)}: true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
}

function migrateProfileSettings(projectDir: string): void {
  const path = join(projectDir, 'pnpm-workspace.yaml')
  if (!existsSync(path)) return
  const legacy = `packages:\n  - .\n\n${WORKSPACE_SETTINGS}strictDepBuilds: true\nallowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  "${CORE_BUILD_PACKAGE}": true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
  if (readFileSync(path, 'utf8').replaceAll('\r\n', '\n') === legacy) {
    writeFileSync(path, workspaceFile())
  }
}

/** Initializes the Desktop profile and disables third-party bundles during recovery. */
export class DesktopProjectManager {
  /**
   * @param paths - Electron-owned package state and reserved desktop profile paths.
   * @param runtime - location of the bundled application runtime.
   */
  constructor(
    readonly paths: DesktopPaths,
    readonly runtime: { readonly dsh: string },
  ) {}

  /**
   * Back up the profile patch and disable third-party bundles without loading application resources.
   * The caller must stop the Host first.
   * @returns Backup path after the locked profile write, or undefined if the patch was absent.
   */
  async disableAllPlugins(): Promise<string | undefined> {
    return this.withLock(() => sanitizeProfile('dsh', this.paths.profile, WEB_PROFILE.bundles))
  }

  /**
   * Load application metadata and prepare the external plugin profile without installing packages.
   */
  async applyRelease(): Promise<void> {
    await this.withLock(() => {
      // Validation only: an unreadable or mismatched runtime descriptor stops preparation before the Host starts.
      readDesktopRuntime(this.runtime.dsh)
      migrateProfileSettings(this.paths.profile)
      createPluginProfile(this.paths.profile)
      removeLinkProjections(this.paths.profile)
    })
  }

  private async withLock<T>(operation: () => T | Promise<T>): Promise<T> {
    mkdirSync(this.paths.profile, { recursive: true, mode: 0o700 })
    const lockPath = join(realpathSync(this.paths.profile), 'lock')
    const { descriptor, token } = acquireProfileLock(lockPath)
    try {
      return await operation()
    } finally {
      closeSync(descriptor)
      // Only remove the lock this acquisition wrote: a takeover by another process must not
      // be undone by the process it displaced.
      if (readLockOwner(lockPath)?.token === token) unlinkSync(lockPath)
    }
  }
}

/** Create build-only project metadata for materializing the signed runtime. */
export function createRuntimeProjectMetadata(projectDir: string, release: DesktopRelease): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const packageSet = verifyDesktopCorePackageSet(projectDir, release.version)
  const manifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: desktopCorePackageOverrides(packageSet),
    dsh: { profile: { bundles: [...WEB_PROFILE.bundles] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(
    join(projectDir, 'pnpm-workspace.yaml'),
    workspaceFile(desktopCorePackageOverrides(packageSet)),
    { mode: 0o600 },
  )
}

/**
 * Create metadata for the unpackaged development project that links the current workspace.
 * @param projectDir - Disposable development profile directory.
 * @param release - Release identity shared by the linked CLI package and Electron shell.
 */
export function createDevelopmentProjectMetadata(projectDir: string, release: DesktopRelease): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const manifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: {
      [DSH_PACKAGE]: release.version,
      [DESKTOP_HOST_PACKAGE]: release.version,
    },
    dsh: { profile: { bundles: [...WEB_PROFILE.bundles] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(join(projectDir, 'pnpm-workspace.yaml'), workspaceFile(), { mode: 0o600 })
}

/** Create the first external plugin profile without running a package manager. */
export function createPluginProfile(projectDir: string): void {
  initProfile(projectDir, WEB_PROFILE.bundles)
}
