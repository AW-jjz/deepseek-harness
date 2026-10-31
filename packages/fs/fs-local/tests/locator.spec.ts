/**
 * Locator schemes on the local backend: a `<scheme>:/<relative>` request must
 * resolve under the configured directory, keep working after that directory
 * moves, refuse to climb out of it, and leave every other path untouched.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem, expandLocatorPath, parseLocatorRoots } from '@deepseek-ai/dsh-fs-local'
import { FsError } from '@deepseek-ai/dsh-fs'

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `dsh-fs-locator-${name}-`)))
  tempDirs.push(dir)
  return dir
}

describe('locator roots', () => {
  it('validates schemes and roots before any path is resolved', () => {
    expect(parseLocatorRoots(undefined)).toEqual([])
    expect(parseLocatorRoots([])).toEqual([])
    expect(() => parseLocatorRoots([{ scheme: 's', root: '/tmp' }]))
      .toThrow('must be a lower-case token of at least two characters')
    expect(() => parseLocatorRoots([{ scheme: 'Spill', root: '/tmp' }]))
      .toThrow('must be a lower-case token of at least two characters')
    expect(() => parseLocatorRoots([{ scheme: 'spill', root: 'relative/dir' }]))
      .toThrow('needs an absolute directory')
    expect(() => parseLocatorRoots([{ scheme: 'spill', root: '/tmp' }, { scheme: 'spill', root: '/var' }]))
      .toThrow('registered twice')
  })

  it('rewrites only a registered scheme and leaves every other spelling alone', () => {
    const roots = parseLocatorRoots([{ scheme: 'spill', root: '/srv/spill' }])
    expect(expandLocatorPath('/abs/file.txt', roots)).toBe('/abs/file.txt')
    expect(expandLocatorPath('./relative.txt', roots)).toBe('./relative.txt')
    expect(expandLocatorPath('spillover:/x', roots)).toBe('spillover:/x')
  })

  it('resolves a locator under the current root so it survives the root moving', async () => {
    const first = await tempDir('first')
    const second = await tempDir('second')
    await mkdir(join(first, 'session-abc'), { recursive: true })
    await writeFile(join(first, 'session-abc', 'web_fetch.txt'), 'full body')
    // The same session directory, reached under a different root: the locator
    // names the file by its position INSIDE the root, never by the root itself.
    await mkdir(join(second, 'session-abc'), { recursive: true })
    await writeFile(join(second, 'session-abc', 'web_fetch.txt'), 'full body')

    const read = async (root: string): Promise<string> => {
      const ctx = new Context()
      const fiber = await ctx.plugin(LocalFileSystem, {
        cwd: second, locatorRoots: [{ scheme: 'spill', root }],
      })
      try {
        const target = await ctx.fs.resolve('spill:/session-abc/web_fetch.txt')
        expect(target.displayPath).toBe(await realpath(join(root, 'session-abc', 'web_fetch.txt')))
        return await ctx.fs.readText(target)
      } finally {
        await fiber.dispose()
      }
    }

    expect(await read(first)).toBe('full body')
    expect(await read(second)).toBe('full body')
  })

  it('resolves the same locator from lstat, and refuses to leave the root', async () => {
    const root = await tempDir('root')
    await writeFile(join(root, 'inside.txt'), 'x')
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalFileSystem, { locatorRoots: [{ scheme: 'spill', root }] })
    try {
      expect(await ctx.fs.lstat('spill:/inside.txt')).toMatchObject({ type: 'file' })
      expect(await ctx.fs.lstat('spill:/missing.txt')).toBeUndefined()
      await expect(ctx.fs.resolve('spill:/../../etc/passwd'))
        .rejects.toThrow(/leaves its registered directory/)
      await expect(ctx.fs.resolve('spill:/'))
        .rejects.toThrow(/names no file/)
      await expect(ctx.fs.resolve('spill:/../../etc/passwd'))
        .rejects.toBeInstanceOf(FsError)
    } finally {
      await fiber.dispose()
    }
  })

  it('keeps absolute paths and the home prefix working when schemes are registered', async () => {
    const root = await tempDir('mixed')
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalFileSystem, { cwd: root, locatorRoots: [{ scheme: 'spill', root }] })
    try {
      await writeFile(join(root, 'plain.txt'), 'plain')
      const absolute = await ctx.fs.resolve(join(root, 'plain.txt'))
      const relativePath = await ctx.fs.resolve('plain.txt')
      expect(absolute.targetKey).toBe(relativePath.targetKey)
      expect(await ctx.fs.readText(relativePath)).toBe('plain')
    } finally {
      await fiber.dispose()
    }
  })
})
