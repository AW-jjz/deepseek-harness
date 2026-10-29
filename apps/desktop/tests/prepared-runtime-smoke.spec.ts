import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertAddonRequirement, readStartupDiagnostics, REQUIRE_ADDON_ENV, smokePreparedRuntime,
} from '../scripts/smoke-prepared-runtime.ts'
import { smokeDesktopRuntime } from '../scripts/smoke-runtime.ts'
import { startupDiagnosticLines } from '../../desktop-host/src/startup-diagnostics.ts'
import { verifyDesktopRuntime, writeDesktopRuntime } from '../src/runtime-tree.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const { payload } = vi.hoisted(() => ({ payload: vi.fn(async (..._args: unknown[]) => ({ stdout: '' })) }))
vi.mock('node:child_process', async (importOriginal) => {
  const { promisify } = await import('node:util')
  return { ...await importOriginal<typeof import('node:child_process')>(),
    execFile: Object.assign(vi.fn(), { [promisify.custom]: payload }) }
})
vi.mock('../scripts/smoke-runtime.ts', () => ({ smokeDesktopRuntime: vi.fn(async () => {}) }))

/** The bridge lines a Host with a flag-only bridge prints. */
const FLAG_ONLY = startupDiagnosticLines({ internalsExposed: true, addonAvailable: false, addonVersion: '0.1.9' })

const roots: string[] = []
const hostArch = Object.getOwnPropertyDescriptor(process, 'arch')!
afterEach(() => {
  Object.defineProperty(process, 'arch', hostArch)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  Reflect.deleteProperty(process.env, REQUIRE_ADDON_ENV)
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

/** Write bytes exactly as the Host child would through its piped stdout. */
const emit = (...lines: readonly string[]): void => { process.stdout.write(`${lines.join('\n')}\n`) }

describe('startup diagnostics gate', () => {
  it('parses the Host lines out of a transcript', () => {
    expect(readStartupDiagnostics(['plugin banner', ...FLAG_ONLY].join('\n')))
      .toEqual({ internalsExposed: true, addonAvailable: false, addonVersion: '0.1.9' })
  })

  it('fails the smoke when the Host stopped printing the lines', () => {
    expect(() => readStartupDiagnostics('desktop runtime: CLI passed\n'))
      .toThrow(/startup diagnostics are missing or malformed/u)
    expect(() => readStartupDiagnostics([FLAG_ONLY[0], 'addon available: false'].join('\n')))
      .toThrow(/missing or malformed/u)
  })

  it('does not gate the addon unless the operator opts in', () => {
    const facts = { internalsExposed: true, addonAvailable: false, addonVersion: '0.1.9' }
    expect(() => { assertAddonRequirement(facts, {}) }).not.toThrow()
    expect(() => { assertAddonRequirement(facts, { [REQUIRE_ADDON_ENV]: '0' }) }).not.toThrow()
    expect(() => { assertAddonRequirement({ ...facts, addonAvailable: true }, { [REQUIRE_ADDON_ENV]: '1' }) }).not.toThrow()
    expect(() => { assertAddonRequirement(facts, { [REQUIRE_ADDON_ENV]: '1' }) })
      .toThrow(/depends on the --expose-internals fallback/u)
  })
})

it('retains payload progress and termination details when the child fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prepared-runtime-failure-'))
  roots.push(root)
  const fixture = runtimeFixture(root)
  const target = { platform: 'win32' as const, arch: 'x64' }
  writeDesktopRuntime(root, fixture.release, fixture.sharedPackages.map(entry => entry.name), target)
  const descriptor = await verifyDesktopRuntime(root, fixture.release.version, target)
  const failure = Object.assign(new Error('payload timed out'), {
    stdout: 'payload output\n', stderr: 'runtime payload: pty\n', killed: true, signal: 'SIGTERM',
  })
  payload.mockRejectedValueOnce(failure)
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  await expect(smokePreparedRuntime(root, join(root, 'electron'), join(root, 'runtime'), descriptor)).rejects.toBe(failure)
  expect(stdout).toHaveBeenCalledWith('payload output\n')
  expect(stderr).toHaveBeenCalledWith('runtime payload: pty\n')
  expect(stderr).toHaveBeenCalledWith('runtime payload: killed=true, signal=SIGTERM\n')
  expect(smokeDesktopRuntime).not.toHaveBeenCalled()
})

it('smokes an x64 target verified on an arm64 build host without revalidating against the host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prepared-runtime-target-'))
  roots.push(root)
  const fixture = runtimeFixture(root)
  const target = { platform: 'darwin' as const, arch: 'x64' }
  writeDesktopRuntime(root, fixture.release, fixture.sharedPackages.map(entry => entry.name), target)
  Object.defineProperty(process, 'arch', { ...hostArch, value: 'arm64' })
  await expect(verifyDesktopRuntime(root, fixture.release.version, { ...target, arch: process.arch }))
    .rejects.toThrow(/incompatible/u)
  const descriptor = await verifyDesktopRuntime(root, fixture.release.version, target)
  const electron = join(root, 'target-electron')
  const resources = join(root, 'runtime')
  vi.mocked(smokeDesktopRuntime).mockImplementationOnce(async () => { emit(...FLAG_ONLY) })
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  // The record is a stdout line; vitest owns `console`, so the assertion reads the console calls.
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
  await smokePreparedRuntime(root, electron, resources, descriptor)
  expect(payload.mock.calls[0]![0]).toBe(electron)
  expect(payload.mock.calls[0]![1]).toEqual(expect.arrayContaining([root, resources]))
  expect(smokeDesktopRuntime).toHaveBeenCalledWith(root, electron, descriptor, expect.any(Object), resources)
  const environment = vi.mocked(smokeDesktopRuntime).mock.calls[0]![3]
  expect(existsSync(environment.NARB_NATIVE_CACHE_DIR!)).toBe(false)
  expect(logs.mock.calls.map(([line]) => String(line)))
    .toContain(JSON.stringify({ internalsExposed: true, addonAvailable: false, addonVersion: '0.1.9' }))
  expect(logs.mock.calls.map(([line]) => String(line)).join('\n')).toContain('the require-builtin addon is dead')
})

it('fails the smoke when the Host child reports no diagnostics at all', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prepared-runtime-unreadable-'))
  roots.push(root)
  const fixture = runtimeFixture(root)
  const target = { platform: 'win32' as const, arch: 'x64' }
  writeDesktopRuntime(root, fixture.release, fixture.sharedPackages.map(entry => entry.name), target)
  const descriptor = await verifyDesktopRuntime(root, fixture.release.version, target)
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  await expect(smokePreparedRuntime(root, join(root, 'electron'), join(root, 'runtime'), descriptor))
    .rejects.toThrow(/startup diagnostics are missing or malformed/u)
})

it('fails the smoke in strict mode while the addon is dead', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prepared-runtime-strict-'))
  roots.push(root)
  const fixture = runtimeFixture(root)
  const target = { platform: 'win32' as const, arch: 'x64' }
  writeDesktopRuntime(root, fixture.release, fixture.sharedPackages.map(entry => entry.name), target)
  const descriptor = await verifyDesktopRuntime(root, fixture.release.version, target)
  vi.mocked(smokeDesktopRuntime).mockImplementationOnce(async () => { emit(...FLAG_ONLY) })
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  process.env[REQUIRE_ADDON_ENV] = '1'
  await expect(smokePreparedRuntime(root, join(root, 'electron'), join(root, 'runtime'), descriptor))
    .rejects.toThrow(new RegExp(`${REQUIRE_ADDON_ENV}=1 but the addon is unavailable`, 'u'))
  expect(stdout).toHaveBeenCalled()
})
