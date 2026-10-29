/** Check payloads and Host boot with private native-cache and Harness directories. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { runtimeArchivePath } from '../../desktop-host/src/office-engine.ts'
import {
  parseStartupDiagnosticLines, type StartupDiagnosticFacts,
} from '../../desktop-host/src/startup-diagnostics.ts'
import { desktopNodeEnvironment } from '../src/node-environment.ts'
import type { DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'
import { scrubWindowsSigningEnvironment } from './windows-sign.mjs'
import { smokeDesktopRuntime } from './smoke-runtime.ts'
import { verifyRuntimeArchive } from './verify-runtime-archive.ts'

/**
 * Opt-in strict mode: refuse a runtime whose `node-addon-require-builtin` cannot serve internals.
 * It stays off by default because the pinned addon does not accept the current Electron
 * fingerprint, so every build would fail today while the `--expose-internals` flag carries startup.
 */
export const REQUIRE_ADDON_ENV = 'DSH_DESKTOP_REQUIRE_ADDON'

/** Why the diagnostics are a gate rather than a log line: docs and the release record cite them. */
const DIAGNOSTICS_CONTRACT = 'apps/desktop-host/src/startup-diagnostics.ts'

/**
 * Read the Host's two R-16 bridge lines out of the output it wrote during the smoke.
 * A missing or reworded line fails the smoke: the release record quotes this text verbatim.
 * @param output - Everything the Host child piped into this process's stdout.
 * @returns The bridge facts the Host reported.
 */
export function readStartupDiagnostics(output: string): StartupDiagnosticFacts {
  const facts = parseStartupDiagnosticLines(output)
  if (facts !== undefined) return facts
  throw new Error('desktop runtime: the Host startup diagnostics are missing or malformed; '
    + '`internals exposed: <bool>` and `addon available: <bool>  version: <v>  via: direct requireBuiltin probe` '
    + `are a machine-read contract (${DIAGNOSTICS_CONTRACT})`)
}

/**
 * Enforce the explicit strict mode, which refuses a runtime whose addon cannot serve internals.
 * @param facts - Bridge facts parsed from the Host output.
 * @param environment - Environment carrying the operator's opt-in.
 * @returns Nothing; throws when the mode is armed and the addon is unavailable.
 */
export function assertAddonRequirement(facts: StartupDiagnosticFacts, environment: NodeJS.ProcessEnv): void {
  if (environment[REQUIRE_ADDON_ENV] !== '1') return
  if (facts.addonAvailable) return
  throw new Error(`desktop runtime: ${REQUIRE_ADDON_ENV}=1 but the addon is unavailable `
    + `(addon available: false, version ${facts.addonVersion}); this startup depends on the `
    + '--expose-internals fallback, and the mode exists to remove it')
}

/** A tee over this process's stdout, which is where the Host child's own pipe ends up. */
interface StdoutCapture {
  readonly text: () => string
  readonly stop: () => void
}

/**
 * Copy everything written to this process's stdout, including the Host child's piped output.
 * @returns The captured text so far, and a stop that restores the real stdout.
 */
function captureStdout(): StdoutCapture {
  const original = process.stdout.write
  let captured = ''
  const tee = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return Reflect.apply(original, process.stdout, [chunk, ...rest]) as boolean
  }) as typeof process.stdout.write
  process.stdout.write = tee
  let stopped = false
  return {
    text: () => captured,
    stop: () => {
      if (stopped) return
      stopped = true
      process.stdout.write = original
    },
  }
}

/**
 * Exercise real runtime files and Host composition, including an ASAR root when packaged.
 * @param root Prepared or archived dsh directory.
 * @param node Target Electron executable.
 * @param resourcesRuntime External runtime directory beside the archive.
 * @param descriptor Runtime descriptor already verified against the selected target, which may differ from the build host.
 * @returns Resolves after archive integrity, payload checks, Host startup, Office conversion and teardown.
 */
export async function smokePreparedRuntime(
  root: string, node: string, resourcesRuntime: string, descriptor: DesktopRuntimeDescriptor,
): Promise<void> {
  const cache = await mkdtemp(join(tmpdir(), 'desktop-native-smoke-'))
  const environment = { ...scrubWindowsSigningEnvironment(process.env), NODE_OPTIONS: '',
    NARB_NATIVE_CACHE_DIR: cache, NARB_DISABLE_NATIVE_CACHE: '0' }
  try {
    const archive = runtimeArchivePath(root)
    if (archive !== undefined) await verifyRuntimeArchive(archive, descriptor)
    const { stdout } = await promisify(execFile)(node, [
      '--expose-internals', resolve(import.meta.dirname, '../tests/fixtures/runtime-payload-smoke.mjs'), root, resourcesRuntime,
    ], { timeout: 120_000, windowsHide: true,
      env: desktopNodeEnvironment(node, join(resourcesRuntime, 'bin'), environment) }).catch((error: unknown) => {
      if (error instanceof Error) {
        if ('stdout' in error && typeof error.stdout === 'string') process.stdout.write(error.stdout)
        if ('stderr' in error && typeof error.stderr === 'string') process.stderr.write(error.stderr)
        if ('killed' in error && 'signal' in error) {
          process.stderr.write(`runtime payload: killed=${String(error.killed)}, signal=${String(error.signal)}\n`)
        }
      }
      throw error
    })
    process.stdout.write(stdout)
    const capture = captureStdout()
    try {
      await smokeDesktopRuntime(root, node, descriptor, environment, resourcesRuntime)
    } finally {
      capture.stop()
    }
    // The record rides the smoke's stdout as one JSON line, beside the payload's own summary line.
    const diagnostics = readStartupDiagnostics(capture.text())
    console.log(JSON.stringify(diagnostics))
    if (!diagnostics.addonAvailable) {
      console.log(`desktop runtime: the require-builtin addon is dead (version ${diagnostics.addonVersion}); `
        + 'startup currently depends on the --expose-internals fallback')
    }
    assertAddonRequirement(diagnostics, process.env)
  } finally {
    await rm(cache, { recursive: true, force: true })
  }
}
