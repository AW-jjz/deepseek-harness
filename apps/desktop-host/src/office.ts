/** Desktop Office skills and bundled authoring dependencies. */

import { statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeArchivePath } from './office-engine.ts'
import type { Context } from '@deepseek-ai/cordis'
import * as officeSkills from '@deepseek-ai/dsh-skill-office'
import * as workspaceDependencies from '@deepseek-ai/dsh-tool-workspace-dependencies'

/** Loader identity for the application-owned Office composition. */
export const name = 'desktop-office'
/** Application-selected bundled payload and installation directories. */
export interface Config {
  /** Bundled payload directory; the sibling `office-skills` assets live beside it. */
  readonly source: string
  /** Harness-home directory where workspace dependencies are installed. */
  readonly root: string
  /** Prepared or ASAR-contained application dependency directory. */
  readonly runtimeDir: string
}

/** Payload locations every Office skill needs at registration time. */
export interface OfficeResources {
  /** Directory holding the bundled `office-*` skill folders. */
  readonly assetRoot: string
  /** Standalone Node executable the skills invoke for LibreOffice Kit. */
  readonly node: string
  /** LibreOffice Kit CLI entry the skills pass to that Node executable. */
  readonly cli: string
}

/** Setting this to `1` turns a missing payload into a startup failure instead of a degradation. */
export const REQUIRE_OFFICE_ENV = 'DSH_DESKTOP_REQUIRE_OFFICE'

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Validate the payload before anything registers.
 *
 * Office authoring is one capability among many: a slice build that ships without the payload, or
 * an install whose runtime directory was pruned, must still open a window. Checking here keeps the
 * decision explicit instead of letting `readFileSync` inside the skill plugin decide it.
 * @param config - Bundled payload source and runtime directory.
 * @param resolveModule - Module resolver; injectable so tests need no packaged runtime.
 * @returns The validated locations, or the first reason the payload cannot be used.
 */
export function resolveOfficeResources(
  config: Config,
  resolveModule: (specifier: string) => string = specifier => import.meta.resolve(specifier),
): { resources: OfficeResources } | { unavailable: string } {
  let cli: string
  try {
    const archive = runtimeArchivePath(config.runtimeDir)
    const manifest = fileURLToPath(resolveModule('@deepseek-ai/libreoffice-kit/package.json'))
    const packageRoot = dirname(archive === undefined ? manifest : join(`${archive}.unpacked`, relative(archive, manifest)))
    cli = join(packageRoot, 'lib', 'cli.js')
  } catch (error) {
    return { unavailable: `LibreOffice Kit engine is not resolvable (${reason(error)})` }
  }
  const checks = [
    ['Office skill assets', join(dirname(config.source), 'office-skills'), 'directory'],
    ['standalone Node executable', join(config.source, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), 'file'],
    ['LibreOffice Kit CLI', cli, 'file'],
  ] as const
  for (const [label, path, kind] of checks) {
    if (!isAbsolute(path)) return { unavailable: `${label} is not an absolute path: ${path}` }
    const stats = statSync(path, { throwIfNoEntry: false })
    if (stats === undefined) return { unavailable: `${label} is missing: ${path}` }
    if (kind === 'directory' ? !stats.isDirectory() : !stats.isFile()) {
      return { unavailable: `${label} is not a ${kind}: ${path}` }
    }
  }
  return { resources: { assetRoot: checks[0][1], node: checks[1][1], cli } }
}

/**
 * Enable offline Office authoring and LibreOffice Kit operations in the Desktop profile.
 *
 * A missing payload degrades to "no Office authoring" with one diagnostic line; packaging
 * verification sets {@link REQUIRE_OFFICE_ENV} so the same gap fails the build instead.
 * @param ctx - Profile scope; child plugins declare their own service requirements.
 * @param config - Bundled payload source and Harness-home installation root.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.plugin(workspaceDependencies, config)
  const resolved = resolveOfficeResources(config)
  if ('unavailable' in resolved) {
    if (process.env[REQUIRE_OFFICE_ENV] === '1') {
      throw new Error(`desktop office: ${resolved.unavailable} (${REQUIRE_OFFICE_ENV}=1)`)
    }
    console.warn(`desktop office: unavailable — ${resolved.unavailable}; continuing without Office authoring`)
    return
  }
  await ctx.plugin(officeSkills, resolved.resources)
}
