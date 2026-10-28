/**
 * Attachment maintenance: the reference scan is all-or-nothing, the daily marker
 * throttles the run, and a missing service or an unreadable log deletes nothing.
 */

import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  ATTACHMENT_SWEEP_INTERVAL_MS, collectReferencedDigests, digestsIn, lastSweepMs, recordSweep,
  runAttachmentMaintenance, type ReferencedSessions,
} from '../src/attachment-maintenance.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

const digest = (seed: string): string => seed.repeat(64).slice(0, 64)
const HOUR = 60 * 60 * 1000

it('finds every digest a body of text names', () => {
  expect(digestsIn(`{"attachmentId":"sha256:${digest('a')}"}`)).toEqual([digest('a')])
  expect(digestsIn(`two sha256:${digest('a')} and sha256:${digest('b')}`)).toEqual([digest('a'), digest('b')])
  expect(digestsIn('sha256:short')).toEqual([])
})

/** A Session persistence stub over fixed event bodies; `failing` names a session whose read rejects. */
function sessions(entries: Record<string, unknown[]>, failing: readonly string[] = []): ReferencedSessions {
  return {
    persistence: {
      list: async () => Object.keys(entries).map(id => ({ header: { id: id as SessionId } })),
      open: async (id: SessionId) => ({
        read: async () => {
          if (failing.includes(id)) throw new Error('disk on fire')
          return { events: entries[id] ?? [] }
        },
        close: async () => {},
      }),
    },
  }
}

describe('reference scan', () => {
  it('collects digests from every stored session', async () => {
    const referenced = await collectReferencedDigests(sessions({
      one: [{ content: [{ type: 'image', attachmentId: `sha256:${digest('a')}` }] }],
      two: [{ content: [`sha256:${digest('b')}`] }],
    }), () => {})
    expect(referenced).toEqual(new Set([digest('a'), digest('b')]))
  })

  it('abandons the scan when any log cannot be read', async () => {
    const warnings: string[] = []
    const referenced = await collectReferencedDigests(sessions({
      one: [{ content: [`sha256:${digest('a')}`] }],
      broken: [],
    }, ['broken']), message => warnings.push(message))
    expect(referenced).toBeUndefined()
    expect(warnings.join('\n')).toContain('broken')
  })

  it('abandons the scan when the session store cannot list', async () => {
    const referenced = await collectReferencedDigests({
      persistence: { list: async () => { throw new Error('store gone') }, open: async () => { throw new Error('unused') } },
    }, () => {})
    expect(referenced).toBeUndefined()
  })
})

describe('daily marker', () => {
  it('round-trips and treats an unreadable marker as absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-attachment-marker-'))
    roots.push(root)
    const path = join(root, 'cache', 'attachment-gc.json')
    expect(lastSweepMs(path)).toBeUndefined()
    recordSweep(path, 1_700_000_000_000)
    expect(lastSweepMs(path)).toBe(1_700_000_000_000)
    await writeFile(path, '{not json')
    expect(lastSweepMs(path)).toBeUndefined()
  })
})

describe('maintenance run', () => {
  /** A context whose Harness home is a temp directory and whose stores are stubs. */
  async function bench(referencedDigest: string): Promise<{ ctx: Context; home: string; objectPath: string }> {
    const home = await mkdtemp(join(tmpdir(), 'dsh-attachment-home-'))
    roots.push(home)
    vi.stubEnv('DSH_HOME', home)
    const objectPath = join(home, 'attachments', 'v1', 'objects', referencedDigest.slice(0, 2), referencedDigest)
    await mkdir(join(home, 'attachments', 'v1', 'objects', referencedDigest.slice(0, 2)), { recursive: true })
    await writeFile(objectPath, 'live')
    const ctx = new Context()
    ctx.provide('attachments', { root: join(home, 'attachments', 'v1') } as never)
    ctx.provide('sessionPersistence', sessions({
      keep: [{ content: [`sha256:${referencedDigest}`] }],
    }).persistence)
    return { ctx, home, objectPath }
  }

  it('keeps referenced objects and records the run', async () => {
    const referenced = digest('a')
    const { ctx, home, objectPath } = await bench(referenced)
    try {
      const result = await runAttachmentMaintenance(ctx, Date.now())
      expect(result).toEqual({ deletedFiles: 0, freedBytes: 0, remainingBytes: 4 })
      expect((await stat(objectPath)).size).toBe(4)
      expect(lastSweepMs(join(home, 'cache', 'attachment-gc.json'))).toBeDefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('skips a run that is not due yet', async () => {
    const { ctx, home } = await bench(digest('a'))
    try {
      const now = Date.now()
      recordSweep(join(home, 'cache', 'attachment-gc.json'), now - HOUR)
      expect(await runAttachmentMaintenance(ctx, now)).toBeUndefined()
      expect(await runAttachmentMaintenance(ctx, now + ATTACHMENT_SWEEP_INTERVAL_MS)).toBeDefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('does nothing without a composed attachment store or session store', async () => {
    const ctx = new Context()
    try {
      expect(await runAttachmentMaintenance(ctx)).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('leaves the marker alone when a log cannot be read', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-attachment-home-'))
    roots.push(home)
    vi.stubEnv('DSH_HOME', home)
    const ctx = new Context()
    ctx.provide('attachments', { root: join(home, 'attachments', 'v1') } as never)
    ctx.provide('sessionPersistence', sessions({ broken: [] }, ['broken']).persistence)
    try {
      expect(await runAttachmentMaintenance(ctx, Date.now())).toBeUndefined()
      expect(lastSweepMs(join(home, 'cache', 'attachment-gc.json'))).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('writes the marker only after the sweep completes', async () => {
    const referenced = digest('a')
    const { ctx, home } = await bench(referenced)
    try {
      await runAttachmentMaintenance(ctx, Date.now())
      const raw = await readFile(join(home, 'cache', 'attachment-gc.json'), 'utf8')
      expect(JSON.parse(raw)).toMatchObject({ at: expect.any(Number) })
    } finally { await ctx.fiber.dispose() }
  })
})
