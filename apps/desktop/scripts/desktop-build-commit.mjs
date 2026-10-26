/**
 * Carry the commit a build came from into its artifacts.
 *
 * A build that reaches a colleague or a test feed is not reachable from a tag,
 * so the only way back to its sources is what the build recorded about itself.
 * The packaging entry reads the checkout once and passes the result to every
 * child process, which run against a build tree rather than a checkout.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** Environment variable that carries the packaged commit. */
export const DESKTOP_BUILD_COMMIT_ENV = 'DSH_DESKTOP_BUILD_COMMIT'

/** Environment variable that records whether the packaged checkout had uncommitted changes. */
export const DESKTOP_BUILD_DIRTY_ENV = 'DSH_DESKTOP_BUILD_DIRTY'

/**
 * Read the checkout's current commit and whether it carries uncommitted changes.
 * @param {string} repositoryRoot - Directory to inspect.
 * @returns {{ commit: string, dirty: boolean }} The commit being packaged and whether its tree was modified.
 */
export function readDesktopBuildCommit(repositoryRoot) {
  const git = (args) => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  return {
    commit: git(['rev-parse', 'HEAD']),
    dirty: git(['status', '--porcelain', '--untracked-files=normal']) !== '',
  }
}

/**
 * Resolve the commit a parent packaging process recorded.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {{ commit: string, dirty: boolean } | undefined} The packaged commit, or undefined outside a packaging run.
 */
export function resolveDesktopBuildCommit(env) {
  const commit = env[DESKTOP_BUILD_COMMIT_ENV]?.trim()
  if (commit === undefined || commit === '') return undefined
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`desktop build commit: ${DESKTOP_BUILD_COMMIT_ENV} must be a commit hash`)
  const dirty = env[DESKTOP_BUILD_DIRTY_ENV]?.trim()
  if (dirty !== undefined && dirty !== '' && dirty !== '0' && dirty !== '1') {
    throw new Error(`desktop build commit: ${DESKTOP_BUILD_DIRTY_ENV} must be 0 or 1`)
  }
  return { commit, dirty: dirty === '1' }
}

/**
 * Describe the packaged commit as the environment variables child processes read.
 * @param {{ commit: string, dirty: boolean }} packaged - Commit and tree state to pass down.
 * @returns {Record<string, string>} Variables to merge into a child environment.
 */
export function desktopBuildCommitEnvironment(packaged) {
  return {
    [DESKTOP_BUILD_COMMIT_ENV]: packaged.commit,
    [DESKTOP_BUILD_DIRTY_ENV]: packaged.dirty ? '1' : '0',
  }
}

/** Environment variable that lets an internal build accept an uncommitted tree. */
export const DESKTOP_ALLOW_DIRTY_BUILD_ENV = 'DSH_DESKTOP_ALLOW_DIRTY_BUILD'

/**
 * Refuse to package a build whose provenance cannot be checked.
 *
 * Three properties are enforced before any artifact exists: the recorded commit must
 * exist in this repository (a build from another clone records a hash nobody here can
 * resolve), the tree must be committed unless the caller explicitly accepts a dirty
 * build, and the installed Electron must be the version the package declares (packaging
 * takes the runtime from `node_modules`, not from the manifest).
 * @param {string} repositoryRoot - Checkout the build is packaged from.
 * @param {string} appRoot - Desktop package directory that declares the Electron version.
 * @param {{ commit: string, dirty: boolean }} packaged - Commit and tree state being packaged.
 * @param {NodeJS.ProcessEnv} [env] - Environment deciding whether a dirty build is accepted.
 * @returns {{ commit: string, dirty: boolean, electron: string }} Provenance facts for the packaging log.
 */
export function assertDesktopBuildProvenance(repositoryRoot, appRoot, packaged, env = process.env) {
  const git = args => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  try {
    // A missing object is the expected rejection, so its git diagnostic stays out of the log.
    execFileSync('git', ['cat-file', '-e', `${packaged.commit}^{commit}`], { cwd: repositoryRoot, stdio: 'ignore' })
  } catch {
    throw new Error(`desktop build provenance: commit ${packaged.commit} is not present in ${repositoryRoot};`
      + ' refusing to package a build whose sources cannot be resolved here')
  }
  const allowDirty = env[DESKTOP_ALLOW_DIRTY_BUILD_ENV]?.trim() === '1'
  if (packaged.dirty && !allowDirty) {
    throw new Error('desktop build provenance: the checkout has uncommitted changes;'
      + ` commit them or set ${DESKTOP_ALLOW_DIRTY_BUILD_ENV}=1 for an internal build that must not be distributed`)
  }
  const require = createRequire(import.meta.url)
  const declared = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).devDependencies?.electron
  if (typeof declared !== 'string') throw new Error('desktop build provenance: apps/desktop/package.json declares no Electron version')
  const expected = declared.replace(/^[\^~]/u, '')
  const installed = JSON.parse(readFileSync(require.resolve('electron/package.json', { paths: [appRoot] }), 'utf8')).version
  if (installed !== expected) {
    throw new Error(`desktop build provenance: node_modules carries Electron ${installed} but the package declares ${expected};`
      + ' the packaged runtime would not match the declared version')
  }
  return { ...packaged, electron: installed }
}
