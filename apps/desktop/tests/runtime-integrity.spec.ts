import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  criticalRuntimeFiles,
  RuntimeIntegrityError,
  verifyCriticalRuntime,
  verifyWholeRuntime,
  writeRuntimeIntegrityRecord,
  RUNTIME_INTEGRITY_RECORD,
} from '../src/runtime-integrity.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-integrity-'))
  roots.push(root)
  runtimeFixture(root)
  return { root }
}

function rewrite(root: string, path: string, text: string): void {
  writeFileSync(join(root, ...path.split('/')), text)
}

describe('desktop runtime integrity', () => {
  it('verifies the Host entry files against the sealed inventory', () => {
    const { root } = fixture()
    const files = criticalRuntimeFiles(root)
    expect(files).toContain('node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js')
    expect(files).toContain('node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
    expect(files).toContain('node_modules/@deepseek-ai/dsh-desktop-host/package.json')
    expect(files).toContain('node_modules/@deepseek-ai/dsh/package.json')
    expect(verifyCriticalRuntime(root).files).toEqual(files)
  })

  it('refuses a critical entry that is one byte different from its record', () => {
    const { root } = fixture()
    rewrite(root, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js', 'tampered\n')
    let failure: unknown
    try {
      verifyCriticalRuntime(root)
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toBeInstanceOf(RuntimeIntegrityError)
    expect((failure as RuntimeIntegrityError).path).toBe('node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js')
  })

  it('refuses a target the runtime was not sealed for', () => {
    const { root } = fixture()
    expect(() => verifyCriticalRuntime(root, { platform: 'linux', arch: 'x64' })).toThrow(RuntimeIntegrityError)
  })

  it('reports a non-critical mismatch from the full pass and accepts the restored tree', async () => {
    const { root } = fixture()
    verifyCriticalRuntime(root)
    rewrite(root, 'node_modules/@deepseek-ai/dsh-base/bundle.yml', 'tampered\n')
    const failed = await verifyWholeRuntime(root)
    expect(failed).toMatchObject({
      ok: false,
      path: 'node_modules/@deepseek-ai/dsh-base/bundle.yml',
    })
    expect(failed.message).toContain('integrity verification failed')

    rewrite(root, 'node_modules/@deepseek-ai/dsh-base/bundle.yml', '[]\n')
    await expect(verifyWholeRuntime(root)).resolves.toMatchObject({ ok: true, files: expect.any(Number) })
  })

  it('reports an extra runtime file that the descriptor does not record', async () => {
    const { root } = fixture()
    rewrite(root, 'node_modules/@deepseek-ai/dsh-base/injected.js', 'export {}\n')
    const report = await verifyWholeRuntime(root)
    expect(report).toMatchObject({ ok: false, path: 'node_modules/@deepseek-ai/dsh-base/injected.js' })
  })

  it('reports a missing descriptor instead of rejecting', async () => {
    const { root } = fixture()
    rmSync(join(root, 'desktop-runtime.json'))
    await expect(verifyWholeRuntime(root)).resolves.toMatchObject({ ok: false, message: expect.any(String) })
  })

  it('writes the outcome where diagnostics can collect it', async () => {
    const { root } = fixture()
    const directory = join(root, 'cache')
    const path = await writeRuntimeIntegrityRecord(directory, { ok: true, files: 7, durationMs: 12 })
    expect(path).toBe(join(directory, RUNTIME_INTEGRITY_RECORD))
    const record: unknown = JSON.parse(readFileSync(path, 'utf8'))
    expect(record).toMatchObject({ schemaVersion: 1, ok: true, files: 7, durationMs: 12, checkedAt: expect.any(String) })
    expect(record).not.toHaveProperty('path')

    await writeRuntimeIntegrityRecord(directory, {
      ok: false, files: 0, durationMs: 3, path: 'node_modules/a/b.js', message: 'mismatch',
    })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      ok: false, path: 'node_modules/a/b.js', message: 'mismatch',
    })
  })
})
