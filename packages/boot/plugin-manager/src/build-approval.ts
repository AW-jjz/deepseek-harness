/** Approve pnpm's pending dependency scripts in the current profile's workspace settings. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isAlias, isMap, isNode, isScalar, parse, parseDocument, visit, type Document } from 'yaml'
import { ManagementFailure } from './failure.ts'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Value pnpm leaves for a build script that still needs a decision. */
const UNDECIDED_BUILD = 'set this to true or false'

/** Where a non-interactive run names the build scripts it skipped. */
const IGNORED_BUILDS = /\bIgnored build scripts: (.+)/

/** The `allowBuilds` key pnpm suggests when it refuses to prepare a git-hosted package; a subdirectory key can contain spaces. */
const GIT_DEP_PREPARE = /ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED[\s\S]*?^allowBuilds:\r?\n[ \t]+(.+?): true$/m

/** A registry version pnpm resolved exactly, as it appears in a dependency path. */
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** A name this profile could have installed; anything else never addresses a manifest path. */
const PACKAGE_NAME = /^(?:@[A-Za-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*$/

/** The package name a key starts with, or `undefined` when the key starts with no package name. */
function packageNameOf(key: string): string | undefined {
  const at = key.indexOf('@', 1)
  const name = at === -1 ? key : key.slice(0, at)
  return PACKAGE_NAME.test(name) ? name : undefined
}

/**
 * Whether a key grants a package rather than one dependency identity.
 * A bare name covers every version pnpm will ever resolve for it, so an approval written under one survives upgrades.
 */
function isUnpinned(key: string): boolean {
  return key.indexOf('@', 1) === -1
}

/** Drop the peer-resolution suffix pnpm appends to a dependency path. */
function withoutPeers(depPath: string): string {
  const open = depPath.indexOf('(')
  return open === -1 ? depPath : depPath.slice(0, open)
}

/**
 * Whether an `allowBuilds` key names a git URL that carries a credential: a password, or any user name over HTTP(S).
 * Such a key is not recorded, so the credential stays out of the profile settings and the pending list.
 */
function carriesCredential(key: string): boolean {
  const at = key.indexOf('@git+')
  if (at === -1) return false
  const url = URL.parse(key.slice(at + '@git+'.length).replace(/#.*$/s, ''))
  return url !== null && (url.password !== '' || (url.username !== '' && /^https?:$/.test(url.protocol)))
}

async function readPolicy(dir: string): Promise<{ document: Document }> {
  let text: string
  try { text = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    text = '{}\n'
  }
  const document = parseDocument(text)
  if (document.errors[0] !== undefined) throw document.errors[0]
  if (!isMap(document.contents)) throw new Error('pnpm-workspace.yaml must be a YAML mapping')
  const builds = document.get('allowBuilds')
  if (builds !== undefined && !isMap(builds)) throw new Error('allowBuilds must be a YAML mapping')
  visit(builds ?? null, (_key, node) => {
    if (isAlias(node) || (isNode(node) && 'anchor' in node && node.anchor)) {
      throw new Error('allowBuilds must not contain YAML anchors or aliases')
    }
  })
  return { document }
}

/** The `allowBuilds` entries as the settings serialize them; a node `setIn` just added is not typed as a scalar yet. */
function buildEntries(document: Document): { key: string; value: unknown }[] {
  const builds = parseDocument(String(document)).get('allowBuilds')
  return isMap(builds) ? builds.items.flatMap(({ key, value }) =>
    isScalar(key) && typeof key.value === 'string' && isScalar(value)
      ? [{ key: key.value, value: value.value }] : []) : []
}

/** Every `allowBuilds` key in document order. */
function buildKeys(document: Document): string[] {
  return buildEntries(document).map(entry => entry.key)
}

/** Every `allowBuilds` key still awaiting a decision; wildcard rules are excluded. */
function pendingKeys(document: Document): string[] {
  return buildEntries(document)
    .filter(entry => entry.value === UNDECIDED_BUILD && !/[*?]/.test(entry.key))
    .map(entry => entry.key)
}

/**
 * The dependency paths pnpm recorded as refused to build in this profile's last run.
 * `node_modules/.modules.yaml` lists them with the version pnpm skipped, which is the identity an approval belongs to.
 */
async function refusedBuilds(dir: string): Promise<string[]> {
  let text: string
  try { text = await readFile(join(dir, 'node_modules', '.modules.yaml'), 'utf8') }
  catch { return [] }
  try {
    const ignored = (parse(text) as { ignoredBuilds?: unknown } | null)?.ignoredBuilds
    return Array.isArray(ignored)
      ? ignored.filter((entry): entry is string => typeof entry === 'string' && entry !== '').map(withoutPeers)
      : []
  } catch { return [] }
}

/** The versions of `name` this profile has on disk, in both linkers pnpm installs with. */
async function installedVersions(dir: string, name: string): Promise<string[]> {
  const versions: string[] = []
  for (const manifest of [
    join(dir, 'node_modules', name, 'package.json'),
    join(dir, 'node_modules', '.pnpm', 'node_modules', name, 'package.json'),
  ]) {
    try {
      const version = (JSON.parse(await readFile(manifest, 'utf8')) as { version?: unknown }).version
      if (typeof version === 'string' && EXACT_VERSION.test(version) && !versions.includes(version)) versions.push(version)
    } catch { /* a linker this profile does not use, or a manifest that is gone */ }
  }
  return versions
}

/**
 * The keys that pin `name` to what this profile actually resolved: the identities pnpm refused to build, or, when it
 * refused none for that name, the versions on disk.
 * @param dir Current profile directory.
 * @param name A package name from a pending entry or an existing broad approval.
 * @returns Dependency identities in report order; empty when this profile can name none.
 */
async function pinnedIdentities(dir: string, name: string): Promise<string[]> {
  if (!PACKAGE_NAME.test(name)) return []
  const refused = (await refusedBuilds(dir)).filter(key => packageNameOf(key) === name)
  if (refused.length > 0) return refused
  return (await installedVersions(dir, name)).map(version => `${name}@${version}`)
}

/**
 * Replace every broad `true` or undecided entry with the identities it resolves to, so an approval covers only what
 * the user's own install resolved instead of every later version of that package.
 * A denial keeps its broad form: pinning one would narrow the refusal to a single version.
 * @param dir Current profile directory.
 * @param document Parsed profile settings, updated in place.
 * @returns The keys written in place of broad entries, and whether the document changed.
 */
async function pinEntries(dir: string, document: Document): Promise<{ pinned: string[]; changed: boolean }> {
  const existing = new Set(buildKeys(document))
  const pinned: string[] = []
  let changed = false
  for (const { key, value } of buildEntries(document)) {
    if (!isUnpinned(key) || (value !== true && value !== UNDECIDED_BUILD)) continue
    const identities = await pinnedIdentities(dir, key)
    if (identities.length === 0) continue
    document.deleteIn(['allowBuilds', key])
    changed = true
    for (const identity of identities) {
      pinned.push(identity)
      // A decision already recorded for this exact identity is the narrower one, so it stays.
      if (existing.has(identity)) continue
      document.setIn(['allowBuilds', identity], value)
      existing.add(identity)
    }
  }
  return { pinned, changed }
}

/**
 * Record the build scripts a failed run reported as blocked, then list every `allowBuilds` key awaiting a decision.
 *
 * pnpm writes those policy entries itself only when it can prompt, and the
 * manager always runs it non-interactively, so the run's own report is the
 * record that survives. A reported bare name is recorded under the identity
 * pnpm refused, because a bare key would allow every later version.
 * @param dir Current profile directory.
 * @param output Captured output of the failed run.
 * @returns Exact `allowBuilds` keys awaiting a build decision; wildcard rules are excluded.
 */
export async function recordPendingBuilds(dir: string, output: string): Promise<string[]> {
  const { document } = await readPolicy(dir)
  const migration = await pinEntries(dir, document)
  const known = new Set(buildKeys(document))
  const added: string[] = []
  for (const reported of blockedBuildNames(output)) {
    for (const identity of isUnpinned(reported) ? await pinnedIdentities(dir, reported) : [reported]) {
      if (known.has(identity) || added.includes(identity)) continue
      added.push(identity)
    }
  }
  if (migration.changed || added.length > 0) {
    for (const key of added) document.setIn(['allowBuilds', key], UNDECIDED_BUILD)
    await writeFileAtomic(join(dir, 'pnpm-workspace.yaml'), String(document), { mode: 0o600 })
  }
  return pendingKeys(document)
}

/**
 * Narrow the broad approvals a profile already carries to the identities it resolved.
 * The installed versions stay allowed, so no decision changes; what goes away is the grant over later versions.
 * @param dir Current profile directory.
 * @returns The keys written in place of broad approvals; empty when the settings needed no change.
 */
export async function pinBroadBuilds(dir: string): Promise<string[]> {
  const { document } = await readPolicy(dir)
  const { pinned, changed } = await pinEntries(dir, document)
  if (changed) await writeFileAtomic(join(dir, 'pnpm-workspace.yaml'), String(document), { mode: 0o600 })
  return pinned
}

/**
 * Read the `allowBuilds` keys a pnpm run reported as ignored build scripts or as a git-hosted package it refused to prepare.
 * @param output Captured output of the run.
 * @returns Exact keys in report order; wildcard patterns and git keys carrying a credential are excluded.
 */
export function blockedBuildNames(output: string): string[] {
  const ignored = IGNORED_BUILDS.exec(output)?.[1]?.split(',') ?? []
  const git = GIT_DEP_PREPARE.exec(output)?.[1]
  return [...ignored, ...git === undefined ? [] : [git]]
    .map(name => name.trim()).filter(name => name !== '' && !/[*?]/.test(name) && !carriesCredential(name))
}

/** Persist approval without running scripts; the caller holds the profile manifest lock.
 *
 * A bare package name is approved under the identities this profile resolved for it, and refused when it resolves to
 * none: a key that covers a whole package would outlive the version the user approved it for.
 * @param dir Current profile directory.
 * @param names Package names or exact approval keys from the pending build list.
 * @throws If an approved key is no longer pending, or names no identity this profile can pin; no approvals are written.
 */
export async function approveBuilds(dir: string, names: readonly string[]): Promise<void> {
  if (names.length === 0) return
  const { document } = await readPolicy(dir)
  await pinEntries(dir, document)
  const pending = new Set(pendingKeys(document))
  const approved: string[] = []
  for (const name of names) {
    const identities = isUnpinned(name) ? await pinnedIdentities(dir, name) : [name]
    if (identities.length === 0 || identities.some(identity => !pending.has(identity))) {
      throw new ManagementFailure('stale-approval')
    }
    for (const identity of identities) if (!approved.includes(identity)) approved.push(identity)
  }
  for (const key of approved) document.setIn(['allowBuilds', key], true)
  await writeFileAtomic(join(dir, 'pnpm-workspace.yaml'), String(document), { mode: 0o600 })
}
