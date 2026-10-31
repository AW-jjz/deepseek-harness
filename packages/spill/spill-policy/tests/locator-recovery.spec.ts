/**
 * The product-level claim of a locator scheme: a saved result's model-facing
 * locator is a `<scheme>:/…` handle, and `read` — that is, `ctx.fs.resolve` on
 * the handle the model copies out of the notice — still opens the file after the
 * whole spill root has been renamed. The absolute path a locator used to carry
 * cannot do that, which is the residual this scheme removes.
 */

import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-locator-recovery-'))
  onTestFinished(async () => { await rm(home, { recursive: true, force: true }) })
  return home
}

describe('spill locator recovery', () => {
  it('reopens a saved result after the spill root is renamed', async () => {
    const home = await tempHome()
    const before = join(home, 'install-a', 'spill')
    const after = join(home, 'install-b', 'spill')

    const writer = new Context()
    await writer.plugin(FileSystem, { cwd: home, locatorRoots: [{ scheme: 'spill', root: before }] })
    await writer.plugin(LocalSpillStore, { root: before, cleanupPeriodDays: 0, locatorScheme: 'spill' })
    onTestFinished(async () => { await writer.fiber.dispose() })

    const ref = await writer.spillStore.saveText({
      owner: { sessionId: SessionId('sess-1') },
      source: { kind: 'tool', toolName: 'web_fetch', callId: ToolCallId('call-1'), label: 'result' },
      suggestedName: 'web_fetch.txt',
      content: 'the full fetched body',
    })
    // What the model sees, and what it copies back into `read`.
    expect(ref.locator.startsWith('spill:/session-')).toBe(true)
    expect(String(ref.locator)).not.toContain(home)

    // The install directory moves — a renamed portable folder, a new DSH_HOME.
    await mkdir(join(home, 'install-b'), { recursive: true })
    await rename(before, after)

    const reader = new Context()
    await reader.plugin(FileSystem, { cwd: home, locatorRoots: [{ scheme: 'spill', root: after }] })
    onTestFinished(async () => { await reader.fiber.dispose() })

    const target = await reader.fs.resolve(ref.locator)
    expect(await reader.fs.readText(target)).toBe('the full fetched body')
  })

  it('keeps an absolute locator readable, and reports a moved one as not found', async () => {
    const home = await tempHome()
    const root = join(home, 'install-a', 'spill')
    await mkdir(join(root, 'session-x'), { recursive: true })
    await writeFile(join(root, 'session-x', 'kept.txt'), 'kept')
    // Written before the scheme existed: the stored spelling is an absolute path,
    // and an unmoved root must keep opening it exactly as it always did.
    const locator = join(root, 'session-x', 'kept.txt')

    const ctx = new Context()
    await ctx.plugin(FileSystem, { cwd: home, locatorRoots: [{ scheme: 'spill', root }] })
    await ctx.plugin(LocalSpillStore, { root, cleanupPeriodDays: 0 })
    onTestFinished(async () => { await ctx.fiber.dispose() })

    expect(await ctx.fs.readText(await ctx.fs.resolve(locator))).toBe('kept')

    await rename(join(home, 'install-a'), join(home, 'install-b'))
    // The documented residual of an absolute locator: it stops resolving. The
    // scheme is the only spelling that survives the move.
    expect(await ctx.fs.stat(await ctx.fs.resolve(locator))).toBeUndefined()
  })
})
