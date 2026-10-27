/**
 * Project-directory layout: names are digests, a store written with readable
 * names stays readable, and mount migrates it. The readable key had to go: it
 * spelled the user name and repository into a directory anyone can list.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { encodeSegment, legacyProjectKey, projectDir, projectKey, sessionDir } from '../src/format.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-key-'))
  roots.push(root)
  return root
}

/** Mount the backend the way a Host does: migration runs before the plugin resolves. */
async function mount(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return ctx
}

async function writeLog(persistence: SessionPersistence, header: SessionHeader): Promise<void> {
  const handle = await persistence.create(header)
  try {
    await handle.append(oneTurnLog())
  } finally {
    await handle.close()
  }
}

/** Project directories under the root, sorted. */
async function projectDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}

/** Move one stored session from its current project directory into another. */
async function moveSession(root: string, header: SessionHeader, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  await rename(sessionDir(root, header.cwd, header.id), join(destination, encodeSegment(header.id)))
}

function seeded(id: string, cwd: string): SessionHeader {
  return meta(id, cwd)
}

describe('project directory keys', () => {
  it('names a new session directory by digest, not by the path it would spell out', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    try {
      const header = seeded('digest-named', '/Users/qyj/private-repository')
      await writeLog(ctx.sessionPersistence, header)

      expect(await projectDirectories(root)).toEqual([projectKey(header.cwd as string)])
      expect(await projectDirectories(root)).not.toContain('--Users-qyj-private-repository--')
    } finally { await ctx.fiber.dispose() }
  })

  it('migrates a readable directory to the hashed key at mount and keeps the session readable', async () => {
    const root = await freshRoot()
    const first = await mount(root)
    const header = seeded('legacy-migrated', '/Users/qyj/private-repository')
    await writeLog(first.sessionPersistence, header)
    await first.fiber.dispose()

    // Rebuild the pre-hash layout: one readable project directory, no hashed one.
    await rename(projectDir(root, header.cwd), join(root, legacyProjectKey(header.cwd as string)))
    expect(await projectDirectories(root)).toEqual([legacyProjectKey(header.cwd as string)])

    const second = await mount(root)
    try {
      expect(await projectDirectories(root)).toEqual([projectKey(header.cwd as string)])
      expect(await readdir(projectDir(root, header.cwd))).toEqual([encodeSegment(header.id)])
      expect((await second.sessionPersistence.list()).map(snapshot => snapshot.header.id)).toEqual([header.id])
      const handle = await second.sessionPersistence.open(header.id, 'read')
      try {
        expect(handle.header.cwd).toBe(header.cwd)
        expect((await handle.read()).events.length).toBeGreaterThan(0)
      } finally { await handle.close() }
    } finally { await second.fiber.dispose() }
  })

  it('leaves a directory whose sessions belong to different paths, and still lists both', async () => {
    const root = await freshRoot()
    const first = await mount(root)
    // These two paths collide under the readable key; migration must not guess.
    const one = seeded('collision-one', '/a/b-c')
    const two = seeded('collision-two', '/a-b/c')
    await writeLog(first.sessionPersistence, one)
    await writeLog(first.sessionPersistence, two)
    await first.fiber.dispose()

    const shared = join(root, legacyProjectKey(one.cwd as string))
    expect(legacyProjectKey(two.cwd as string)).toBe(legacyProjectKey(one.cwd as string))
    await mkdir(shared, { recursive: true })
    await moveSession(root, one, shared)
    await moveSession(root, two, shared)
    await rm(projectDir(root, one.cwd), { recursive: true, force: true })
    await rm(projectDir(root, two.cwd), { recursive: true, force: true })

    const second = await mount(root)
    try {
      expect(await projectDirectories(root)).toEqual([legacyProjectKey(one.cwd as string)])
      const ids = (await second.sessionPersistence.list()).map(snapshot => snapshot.header.id)
      expect(ids.sort()).toEqual([one.id, two.id].sort())
      for (const id of [one.id, two.id]) {
        const handle = await second.sessionPersistence.open(id, 'read')
        try {
          expect((await handle.read()).events.length).toBeGreaterThan(0)
        } finally { await handle.close() }
      }
    } finally { await second.fiber.dispose() }
  })

  it('merges a readable directory into one the hashed layout already uses', async () => {
    const root = await freshRoot()
    const first = await mount(root)
    const earlier = seeded('merge-earlier', '/work/merged')
    const later = seeded('merge-later', '/work/merged')
    await writeLog(first.sessionPersistence, earlier)
    await writeLog(first.sessionPersistence, later)
    await first.fiber.dispose()

    // Split the pair across both layouts: the target now exists and is not empty.
    const hashed = projectDir(root, earlier.cwd)
    const readable = join(root, legacyProjectKey(earlier.cwd as string))
    await mkdir(readable, { recursive: true })
    await moveSession(root, earlier, readable)
    expect((await readdir(hashed)).sort()).toEqual([encodeSegment(later.id)])

    const second = await mount(root)
    try {
      expect(await projectDirectories(root)).toEqual([projectKey(earlier.cwd as string)])
      const stored = await readdir(projectDir(root, earlier.cwd))
      expect(stored.sort()).toEqual([encodeSegment(earlier.id), encodeSegment(later.id)].sort())
      const ids: SessionId[] = (await second.sessionPersistence.list()).map(snapshot => snapshot.header.id)
      expect(ids.sort()).toEqual([earlier.id, later.id].sort())
    } finally { await second.fiber.dispose() }
  })
})
