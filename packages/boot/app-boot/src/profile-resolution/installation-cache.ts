/**
 * Persisted installation-scope cache.
 *
 * Walking the installation's dependency graph reads one `package.json` per
 * package — around five hundred files on Windows, where each open pays for
 * antivirus and path resolution. The graph is a property of one install: it
 * changes only when the installation itself is replaced. The cache records the
 * graph beside the profile, keyed by a fingerprint of that install, and any
 * doubt (a missing or unreadable cache, a different fingerprint, a malformed
 * entry) falls back to the full walk.
 * @module @deepseek-ai/dsh-app-boot/profile-resolution/installation-cache
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Cache format version; a bump discards every older file. */
const CACHE_VERSION = 1

/** One cached installation scope, in the shape the walk produces. */
export interface CachedInstallationScope {
  readonly packageNames: readonly string[]
  readonly packageDirs: readonly (readonly [string, string])[]
  readonly declarers: readonly (readonly [string, string])[]
  readonly versions: readonly (readonly [string, string | null])[]
}

/** On-disk envelope: the fingerprint the entry belongs to, then the graph. */
interface CacheEnvelope extends CachedInstallationScope {
  readonly version: number
  readonly key: string
}

/**
 * Where one profile keeps its installation cache.
 * @param home - Harness home (`$DSH_HOME`), which also holds the profiles.
 * @returns absolute cache file path.
 */
export function installationCachePath(home: string): string {
  return join(home, 'cache', 'installation-scope.json')
}

/** One file's participation in the fingerprint. */
function statLine(path: string): string {
  try {
    const stats = statSync(path)
    return `${path}:${String(stats.mtimeMs)}:${String(stats.size)}`
  } catch {
    return `${path}:absent`
  }
}

/**
 * Fingerprint the installation this graph belongs to.
 *
 * The app manifest covers a replaced installation; pnpm's `.modules.yaml`
 * covers an install whose dependency versions or links changed in place. When
 * neither marker is readable the walk still runs — a cache is never worth a
 * stale answer.
 * @param canonicalAnchor - absolute `package.json` of the running installation.
 * @param skippedBundles - profile bundles read through the profile manifest path.
 * @returns a hexadecimal fingerprint, or `undefined` when the anchor is unreadable.
 */
export function installationFingerprint(canonicalAnchor: string, skippedBundles: ReadonlySet<string>): string | undefined {
  const anchor = statLine(canonicalAnchor)
  if (anchor.endsWith(':absent')) return undefined
  const parts = [anchor]
  // `node_modules/.modules.yaml` is pnpm's own install record: its mtime moves
  // whenever an install rewrites the tree, in place or not.
  let modules = dirname(canonicalAnchor)
  for (let depth = 0; depth < 4; depth += 1) {
    if (basename(modules) === 'node_modules') {
      parts.push(statLine(join(modules, '.modules.yaml')))
      break
    }
    const parent = dirname(modules)
    if (parent === modules) break
    modules = parent
  }
  parts.push(`skipped:${[...skippedBundles].sort().join(',')}`)
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

/**
 * Read a cached scope for this fingerprint.
 * @param cachePath - file written by {@link writeInstallationScope}.
 * @param key - fingerprint from {@link installationFingerprint}.
 * @returns the cached scope, or `undefined` when the cache is missing, stale, or malformed.
 */
export function readInstallationScope(cachePath: string, key: string): CachedInstallationScope | undefined {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(cachePath, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as Partial<CacheEnvelope>
  if (entry.version !== CACHE_VERSION || entry.key !== key) return undefined
  if (!Array.isArray(entry.packageNames) || !entry.packageNames.every(name => typeof name === 'string')) return undefined
  const pairs = (input: unknown): readonly (readonly [string, string])[] | undefined => {
    if (!Array.isArray(input)) return undefined
    const out: (readonly [string, string])[] = []
    for (const item of input) {
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || typeof item[1] !== 'string') return undefined
      out.push([item[0], item[1]])
    }
    return out
  }
  const packageDirs = pairs(entry.packageDirs)
  const declarers = pairs(entry.declarers)
  if (packageDirs === undefined || declarers === undefined || !Array.isArray(entry.versions)) return undefined
  const versions: (readonly [string, string | null])[] = []
  for (const item of entry.versions) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string') return undefined
    if (item[1] !== null && typeof item[1] !== 'string') return undefined
    versions.push([item[0], item[1]])
  }
  return { packageNames: entry.packageNames, packageDirs, declarers, versions }
}

/**
 * Persist one computed scope. Best effort: a cache that cannot be written only
 * costs the next start its walk.
 * @param cachePath - destination from {@link installationCachePath}.
 * @param key - fingerprint the scope was computed for.
 * @param scope - the computed graph.
 */
export function writeInstallationScope(cachePath: string, key: string, scope: CachedInstallationScope): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 })
    const envelope: CacheEnvelope = { version: CACHE_VERSION, key, ...scope }
    writeFileSync(cachePath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 })
  } catch {
    // The walk is the fallback; a read-only home must not fail the boot.
  }
}
