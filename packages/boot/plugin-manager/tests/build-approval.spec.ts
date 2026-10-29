/** Pending script permissions survive cleanup, preserve unrelated workspace settings, and name one exact dependency. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { parse } from 'yaml'
import { approveBuilds, pinBroadBuilds, recordPendingBuilds } from '../src/build-approval.ts'

function fixture(text?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'build-approval-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  const filename = join(dir, 'pnpm-workspace.yaml')
  if (text !== undefined) writeFileSync(filename, text)
  return { dir, filename }
}

/** Write the manifest of a package this profile installed, at the path pnpm links it to. */
function installed(dir: string, name: string, version: string, linker = 'root'): void {
  const base = linker === 'root'
    ? join(dir, 'node_modules', name)
    : join(dir, 'node_modules', '.pnpm', 'node_modules', name)
  mkdirSync(base, { recursive: true })
  writeFileSync(join(base, 'package.json'), JSON.stringify({ name, version }))
}

/** Record the dependency paths pnpm refused to build in its own module manifest. */
function refused(dir: string, ...paths: string[]): void {
  const modules = join(dir, 'node_modules', '.modules.yaml')
  mkdirSync(dirname(modules), { recursive: true })
  writeFileSync(modules, JSON.stringify({ layoutVersion: 5, ignoredBuilds: paths }))
}

it('approves only named pending packages and preserves comments, decisions and settings', async () => {
  const { dir, filename } = fixture('# profile settings\nother: &unrelated value\ncopy: *unrelated\nnodeLinker: hoisted\nallowBuilds:\n  native: set this to true or false\n  "@scope/other": set this to true or false\n  trusted: true\n  denied: false\n  "@scope/*": set this to true or false\n')
  installed(dir, 'native', '1.0.0')
  // Migration replaces the broad key, and a replaced key sorts at the end of the mapping.
  expect(await recordPendingBuilds(dir, '')).toEqual(['@scope/other', 'native@1.0.0'])
  await approveBuilds(dir, ['native@1.0.0'])
  const text = readFileSync(filename, 'utf8')
  expect(text).toContain('# profile settings')
  expect(parse(text)).toMatchObject({ nodeLinker: 'hoisted', allowBuilds: { 'native@1.0.0': true, trusted: true, denied: false } })
  expect(await recordPendingBuilds(dir, '')).toEqual(['@scope/other'])
})

it.each(['missing', 'denied', '*', '--all'])('rejects an unlisted approval atomically: %s', async (name) => {
  const original = 'allowBuilds:\n  native: set this to true or false\n  denied: false\n'
  const { dir, filename } = fixture(original)
  await expect(approveBuilds(dir, ['native', name])).rejects.toThrow('stale-approval')
  expect(readFileSync(filename, 'utf8')).toBe(original)
})

it('refuses a bare approval this profile cannot pin to an installed version', async () => {
  const original = 'allowBuilds:\n  native: set this to true or false\n'
  const { dir, filename } = fixture(original)
  // The profile kept no manifest for it, so writing `native: true` would approve every later version as well.
  await expect(approveBuilds(dir, ['native'])).rejects.toThrow('stale-approval')
  expect(readFileSync(filename, 'utf8')).toBe(original)
})

it('approves a bare pending name under the version this profile installed', async () => {
  const { dir, filename } = fixture('allowBuilds:\n  native: set this to true or false\n')
  installed(dir, 'native', '3.2.1')
  await approveBuilds(dir, ['native'])
  expect(parse(readFileSync(filename, 'utf8'))).toEqual({ allowBuilds: { 'native@3.2.1': true } })
})

it('records a bare report under the version pnpm refused to build', async () => {
  const { dir, filename } = fixture()
  refused(dir, 'native@2.1.0(zod@3.0.0)', 'other@1.0.0')
  expect(await recordPendingBuilds(dir, '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: native\n'))
    .toEqual(['native@2.1.0'])
  expect(parse(readFileSync(filename, 'utf8'))).toEqual({ allowBuilds: { 'native@2.1.0': 'set this to true or false' } })
})

it('records every installed version a bare report resolves to', async () => {
  const { dir } = fixture()
  installed(dir, 'native', '1.0.0')
  installed(dir, 'native', '2.0.0', 'pnpm')
  expect(await recordPendingBuilds(dir, '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: native\n'))
    .toEqual(['native@1.0.0', 'native@2.0.0'])
})

it('leaves a bare report this profile cannot pin unrecorded rather than granting every version', async () => {
  const { dir, filename } = fixture('nodeLinker: hoisted\n')
  expect(await recordPendingBuilds(dir, '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: ghost\n')).toEqual([])
  expect(readFileSync(filename, 'utf8')).toBe('nodeLinker: hoisted\n')
})

it('narrows a broad approval to the version this profile resolved', async () => {
  const { dir, filename } = fixture('allowBuilds:\n  native: true\n  trusted: true\n')
  refused(dir, 'native@1.4.0')
  expect(await pinBroadBuilds(dir)).toEqual(['native@1.4.0'])
  expect(parse(readFileSync(filename, 'utf8'))).toEqual({ allowBuilds: { 'native@1.4.0': true, trusted: true } })
})

it('leaves a broad denial broad, because pinning one would allow every other version', async () => {
  const original = 'allowBuilds:\n  native: false\n'
  const { dir, filename } = fixture(original)
  installed(dir, 'native', '1.0.0')
  expect(await pinBroadBuilds(dir)).toEqual([])
  expect(readFileSync(filename, 'utf8')).toBe(original)
})

it('keeps a decision already recorded for the exact identity', async () => {
  const { dir, filename } = fixture('allowBuilds:\n  native: true\n  native@1.0.0: false\n')
  installed(dir, 'native', '1.0.0')
  expect(await pinBroadBuilds(dir)).toEqual(['native@1.0.0'])
  expect(parse(readFileSync(filename, 'utf8'))).toEqual({ allowBuilds: { 'native@1.0.0': false } })
})

it('leaves a profile without settings untouched', async () => {
  const { dir, filename } = fixture()
  installed(dir, 'native', '1.0.0')
  expect(await pinBroadBuilds(dir)).toEqual([])
  expect(existsSync(filename)).toBe(false)
})

it('preserves pnpm file dependency selectors verbatim', async () => {
  const name = '@scope/addon@file:../local addon'
  const { dir, filename } = fixture(`allowBuilds:\n  '${name}': set this to true or false\n`)
  expect(await recordPendingBuilds(dir, '')).toEqual([name])
  await approveBuilds(dir, [name])
  expect(parse(readFileSync(filename, 'utf8'))).toEqual({ allowBuilds: { [name]: true } })
})

it.each([undefined, '{}\n', 'nodeLinker: hoisted\n', 'allowBuilds: {}\n'])('has no pending approval without pnpm placeholders: %s', async (text) => {
  const { dir } = fixture(text)
  expect(await recordPendingBuilds(dir, '')).toEqual([])
  await approveBuilds(dir, [])
})

it.each(['[', '[]\n', 'allowBuilds: false\n'])('rejects malformed workspace settings without rewriting them: %s', async (text) => {
  const { dir, filename } = fixture(text)
  await expect(recordPendingBuilds(dir, '')).rejects.toThrow()
  await expect(approveBuilds(dir, ['native'])).rejects.toThrow()
  expect(readFileSync(filename, 'utf8')).toBe(text)
})

it('reports unreadable workspace settings', async () => {
  const { dir, filename } = fixture()
  mkdirSync(filename)
  await expect(recordPendingBuilds(dir, '')).rejects.toThrow()
})

it.each([
  'allowBuilds:\n  native: &pending set this to true or false\n  other: *pending\n',
  'allowBuilds: &builds\n  native: set this to true or false\nshared: *builds\n',
  'shared: &pending set this to true or false\nallowBuilds:\n  native: *pending\n',
])('rejects shared YAML approval nodes without changing permissions: %s', async (original) => {
  const { dir, filename } = fixture(original)
  await expect(approveBuilds(dir, ['native'])).rejects.toThrow()
  expect(readFileSync(filename, 'utf8')).toBe(original)
})

it('records the ignored build scripts a non-interactive run reported', async () => {
  const { dir, filename } = fixture('# profile settings\nnodeLinker: hoisted\n')
  const output = [
    'Progress: resolved 2, reused 2, downloaded 0, added 2, done',
    '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: native@1.0.0, @scope/other@file:../other, @scope/*',
    '',
    'Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.',
  ].join('\n')

  expect(await recordPendingBuilds(dir, output)).toEqual(['native@1.0.0', '@scope/other@file:../other'])
  const text = readFileSync(filename, 'utf8')
  expect(text).toContain('# profile settings')
  expect(parse(text)).toMatchObject({
    nodeLinker: 'hoisted',
    allowBuilds: { 'native@1.0.0': 'set this to true or false', '@scope/other@file:../other': 'set this to true or false' },
  })
  expect(await recordPendingBuilds(dir, output)).toEqual(['native@1.0.0', '@scope/other@file:../other'])
  await approveBuilds(dir, ['native@1.0.0'])
  expect(parse(readFileSync(filename, 'utf8'))).toMatchObject({ allowBuilds: { 'native@1.0.0': true } })
})

function gitPrepareRefusal(key: string, eol = '\n') {
  return [
    '[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from "https://example.com/sidechat.git": The git-hosted package "@scope/sidechat@0.2.0" needs to execute build scripts but is not in the "allowBuilds" allowlist.',
    '',
    'Add the package to "allowBuilds" in your project\'s pnpm-workspace.yaml to allow it to run scripts. For example:',
    'allowBuilds:',
    `  ${key}: true`,
    '',
  ].join(eol)
}

it.each([
  ['LF', '@scope/sidechat@git+https://example.com/sidechat.git#244b67419a80844f5fb1fd7971109b9c19a20b76', '\n'],
  ['CRLF', '@scope/sidechat@git+https://example.com/sidechat.git#244b67419a80844f5fb1fd7971109b9c19a20b76', '\r\n'],
  ['a subdirectory with a space', '@scope/sidechat@git+file:///repo#244b67419a80844f5fb1fd7971109b9c19a20b76&path:plugin folder', '\n'],
  ['an SSH user name', '@scope/sidechat@git+ssh://git@example.com/sidechat.git#244b67419a80844f5fb1fd7971109b9c19a20b76', '\n'],
])('records the allowBuilds key pnpm suggests for a git-hosted package it refused to prepare (%s)', async (_label, key, eol) => {
  const { dir, filename } = fixture()
  expect(await recordPendingBuilds(dir, gitPrepareRefusal(key, eol))).toEqual([key])
  await approveBuilds(dir, [key])
  expect(parse(readFileSync(filename, 'utf8'))).toMatchObject({ allowBuilds: { [key]: true } })
})

it.each([
  '@scope/sidechat@git+https://user:token@example.com/sidechat.git#244b67419a80844f5fb1fd7971109b9c19a20b76',
  '@scope/sidechat@git+http://token@example.com/sidechat.git#244b67419a80844f5fb1fd7971109b9c19a20b76',
  '@scope/sidechat@git+ssh://git:secret@example.com/sidechat.git#244b67419a80844f5fb1fd7971109b9c19a20b76',
])('does not record a git key that carries a credential: %s', async (key) => {
  const { dir, filename } = fixture()
  expect(await recordPendingBuilds(dir, gitPrepareRefusal(key))).toEqual([])
  expect(await recordPendingBuilds(dir, `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: ${key}\n`)).toEqual([])
  expect(existsSync(filename)).toBe(false)
})

it.each([
  ['no report', 'Progress: resolved 1, reused 1, downloaded 0, added 1, done\n'],
  ['an empty report', '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: \n'],
  ['only wildcards', '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @scope/*, native@?\n'],
])('leaves the profile settings untouched for %s', async (_label, output) => {
  const original = 'allowBuilds:\n  decided: true\n'
  const { dir, filename } = fixture(original)
  expect(await recordPendingBuilds(dir, output)).toEqual([])
  expect(readFileSync(filename, 'utf8')).toBe(original)
})

it('preserves approval keys that are not package names', async () => {
  const { dir, filename } = fixture('allowBuilds:\n  1: true\n')
  expect(await recordPendingBuilds(dir, '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: native@1.0.0\n'))
    .toEqual(['native@1.0.0'])
  expect(parse(readFileSync(filename, 'utf8'))).toMatchObject({
    allowBuilds: { 1: true, 'native@1.0.0': 'set this to true or false' },
  })
})
