/**
 * Installation-scope cache: what invalidates the fingerprint, what the reader
 * refuses, and the behavioral contract — a hit skips the manifest walk, and an
 * explicit reread still sees the disk.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installationCachePath, installationFingerprint, readInstallationScope, writeInstallationScope,
} from '../src/profile-resolution/installation-cache.ts'
import { createRuntimeResolution } from '../src/profile.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function file(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function pkg(dir: string, name: string, version: string, dependencies: Record<string, string> = {}): string {
  const anchor = join(dir, 'package.json')
  file(anchor, JSON.stringify({ name, version, type: 'module', exports: { import: './index.js' }, dependencies }))
  file(join(dir, 'index.js'), 'export const marker = 1\n')
  return anchor
}

/** One fake installation: the running dsh plus one dependency. */
function installation(): { root: string; installAnchor: string; dependency: string; modulesState: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installation-cache-'))
  roots.push(root)
  const modulesRoot = join(root, 'global', 'node_modules')
  const installDir = join(modulesRoot, '@deepseek-ai', 'dsh')
  const dependency = join(installDir, 'node_modules', '@deepseek-ai', 'dsh-dep')
  const installAnchor = pkg(installDir, '@deepseek-ai/dsh', '0.0.1', { '@deepseek-ai/dsh-dep': '*' })
  pkg(dependency, '@deepseek-ai/dsh-dep', '1.0.0')
  // pnpm writes its install state beside the app, in the install root's node_modules.
  const modulesState = join(modulesRoot, '.modules.yaml')
  file(modulesState, 'hoistPattern: []\n')
  return { root, installAnchor, dependency, modulesState }
}

/** Move a file's mtime forward without changing its bytes. */
function touch(path: string): void {
  const next = new Date(statSync(path).mtimeMs + 5_000)
  utimesSync(path, next, next)
}

describe('installation fingerprint', () => {
  it('changes with the install manifest, pnpm state, and skipped bundles', () => {
    const f = installation()
    const base = installationFingerprint(f.installAnchor, new Set())
    expect(base).toMatch(/^[0-9a-f]{64}$/u)
    expect(installationFingerprint(f.installAnchor, new Set())).toBe(base)
    expect(installationFingerprint(f.installAnchor, new Set(['pkg-a']))).not.toBe(base)

    touch(f.installAnchor)
    const afterManifest = installationFingerprint(f.installAnchor, new Set())
    expect(afterManifest).not.toBe(base)

    touch(f.modulesState)
    expect(installationFingerprint(f.installAnchor, new Set())).not.toBe(afterManifest)
  })

  it('reports no fingerprint when the installation has no manifest', () => {
    expect(installationFingerprint(join(tmpdir(), 'missing-install', 'package.json'), new Set())).toBeUndefined()
  })
})

describe('cache records', () => {
  const scope = {
    packageNames: ['@deepseek-ai/dsh'],
    packageDirs: [['@deepseek-ai/dsh', '/install']] as const,
    declarers: [['@deepseek-ai/dsh', '/install/package.json']] as const,
    versions: [['@deepseek-ai/dsh', '0.0.1']] as const,
  }

  it('round-trips a scope for one fingerprint', () => {
    const f = installation()
    const path = installationCachePath(f.root)
    writeInstallationScope(path, 'key-a', scope)
    expect(readInstallationScope(path, 'key-a')).toEqual(scope)
    expect(readInstallationScope(path, 'key-b')).toBeUndefined()
  })

  it('refuses a malformed or foreign record instead of trusting it', () => {
    const f = installation()
    const path = installationCachePath(f.root)
    mkdirSync(dirname(path), { recursive: true })
    for (const raw of ['', '{', 'null', '[]', '{"version":99,"key":"k"}', '{"version":1,"key":"k","packageNames":"x"}',
      '{"version":1,"key":"k","packageNames":[],"packageDirs":[["a"]],"declarers":[],"versions":[]}',
      '{"version":1,"key":"k","packageNames":[],"packageDirs":[],"declarers":[],"versions":[["a",3]]}']) {
      writeFileSync(path, raw)
      expect(readInstallationScope(path, 'k')).toBeUndefined()
    }
    expect(readInstallationScope(join(f.root, 'cache', 'absent.json'), 'k')).toBeUndefined()
  })

  it('stays silent when the cache cannot be written', () => {
    const f = installation()
    // A file where the cache directory should be: mkdir fails, nothing throws.
    const blocked = join(f.root, 'cache')
    writeFileSync(blocked, 'not a directory')
    expect(() => { writeInstallationScope(join(blocked, 'installation-scope.json'), 'k', scope) }).not.toThrow()
  })
})

describe('resolution reuse', () => {
  it('skips the manifest walk on a hit, and a reread still sees the disk', async () => {
    const f = installation()
    const first = await createRuntimeResolution({ installAnchor: f.installAnchor, home: f.root })
    expect(first.entries.map(entry => entry.name)).toEqual(['@deepseek-ai/dsh', '@deepseek-ai/dsh-dep'])
    expect(JSON.parse(readFileSync(installationCachePath(f.root), 'utf8'))).toMatchObject({ version: 1 })

    // Corrupting a dependency manifest proves whether the next resolution really
    // reads it: a cache hit must not, and a reread must fail on it.
    writeFileSync(join(f.dependency, 'package.json'), '{ broken')
    const reused = await createRuntimeResolution({ installAnchor: f.installAnchor, home: f.root })
    expect(reused.entries.map(entry => entry.name)).toEqual(first.entries.map(entry => entry.name))
    await expect(createRuntimeResolution({
      installAnchor: f.installAnchor, home: f.root, rereadInstallation: true,
    })).rejects.toThrow()
  })

  it('walks again when the installation changes', async () => {
    const f = installation()
    await createRuntimeResolution({ installAnchor: f.installAnchor, home: f.root })
    pkg(f.dependency, '@deepseek-ai/dsh-dep', '2.0.0')
    touch(f.modulesState)

    const next = await createRuntimeResolution({ installAnchor: f.installAnchor, home: f.root })
    expect(next.entries.find(entry => entry.name === '@deepseek-ai/dsh-dep')?.version).toBe('2.0.0')
  })

  it('boots without a writable home by walking every time', async () => {
    const f = installation()
    const blocked = join(f.root, 'cache')
    writeFileSync(blocked, 'not a directory')
    const resolution = await createRuntimeResolution({ installAnchor: f.installAnchor, home: f.root })
    expect(resolution.entries).toHaveLength(2)
  })
})
