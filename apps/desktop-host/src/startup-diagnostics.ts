/**
 * Machine-readable R-16 bridge diagnostics for the Desktop Host startup.
 *
 * The two lines printed here are a contract, not a log convenience: the release record,
 * `pnpm-workspace.yaml` and the packaging smoke read them. They therefore live in one place
 * that both prints and parses them, so text and consumer can never drift apart.
 */

import { createRequire } from 'node:module'

/** Why the internals flag still ships: the pinned addon has no fingerprint for this Electron. */
const INTERNALS_REASON = 'R-16 addon bridge; expires 2027-01-24'

/** How the addon's answer was obtained, quoted verbatim by the release record. */
const ADDON_PROBE = 'direct requireBuiltin probe'

/** What the two startup lines carry. */
export interface StartupDiagnosticFacts {
  readonly internalsExposed: boolean
  readonly addonAvailable: boolean
  readonly addonVersion: string
}

/** The facts plus the exact lines that describe them, in print order. */
export interface StartupDiagnostics extends StartupDiagnosticFacts {
  readonly lines: readonly [string, string]
}

/** Escape a literal for a regular expression, so the rendered text stays the single source of truth. */
function escapePattern(literal: string): string {
  return literal.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** `internals exposed: <bool>` with the reason suffix only while the flag is the cause. */
const INTERNALS_PATTERN = new RegExp(
  `^internals exposed: (true|false)(?: {2}reason: ${escapePattern(INTERNALS_REASON)})?$`, 'u',
)

/** `addon available: <bool>  version: <v>  via: <probe>`; the version may not be blank. */
const ADDON_PATTERN = new RegExp(
  `^addon available: (true|false) {2}version: (\\S+) {2}via: ${escapePattern(ADDON_PROBE)}$`, 'u',
)

/**
 * Render the two R-16 bridge lines.
 * The separators (two spaces), the field order and the `via:` wording are grep targets in
 * documentation and release records, so they must not change without updating those too.
 * @param facts - Bridge state to render.
 * @returns The internals line and the addon line, in print order.
 */
export function startupDiagnosticLines(facts: StartupDiagnosticFacts): readonly [string, string] {
  const reason = facts.internalsExposed ? `  reason: ${INTERNALS_REASON}` : ''
  return [
    `internals exposed: ${facts.internalsExposed}${reason}`,
    `addon available: ${facts.addonAvailable}  version: ${facts.addonVersion}  via: ${ADDON_PROBE}`,
  ]
}

/** Locate a packaged module the way the Host entry does: from this file's own location. */
function defaultModuleLoader(moduleId: string): unknown {
  const require = createRequire(import.meta.url)
  return require(moduleId)
}

/**
 * Probe the R-16 bridge in this process: whether V8 internals are exposed by the flag, and
 * whether the resolver's addon still answers for them.
 * @param execArgv - Runtime flags to inspect; defaults to this process's.
 * @param load - Module loader; defaults to this file's own resolution.
 * @returns The bridge state plus the lines that describe it.
 */
export function inspectInternalsBridge(
  execArgv: readonly string[] = process.execArgv,
  load: (moduleId: string) => unknown = defaultModuleLoader,
): StartupDiagnostics {
  const internalsExposed = execArgv.includes('--expose-internals')
  let addonAvailable = false
  let addonVersion = 'unknown'
  try {
    try {
      addonVersion = (load('node-addon-require-builtin/package.json') as { version: string }).version
    } catch { /* the addon's exports map may hide its manifest; the line still reports the probe */ }
    const addon = load('node-addon-require-builtin') as { requireBuiltin(moduleId: string): unknown }
    addonAvailable = addon.requireBuiltin('internal/modules/cjs/loader') !== undefined
  } catch { addonAvailable = false }
  const facts: StartupDiagnosticFacts = { internalsExposed, addonAvailable, addonVersion }
  return { ...facts, lines: startupDiagnosticLines(facts) }
}

/**
 * Read the two startup lines back out of a Host transcript.
 * @param output - Everything the Host wrote to stdout, in order.
 * @returns The parsed facts, or undefined when either line is absent, repeated or malformed.
 */
export function parseStartupDiagnosticLines(output: string): StartupDiagnosticFacts | undefined {
  let internals: { readonly exposed: boolean } | undefined
  let addon: { readonly available: boolean; readonly version: string } | undefined
  for (const raw of output.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const internalsMatch = INTERNALS_PATTERN.exec(line)
    if (internalsMatch !== null) {
      if (internals !== undefined) return undefined
      const exposed = internalsMatch[1] === 'true'
      // A reason on a non-exposed line, or none on an exposed one, means the renderer changed.
      if (exposed !== line.includes('  reason: ')) return undefined
      internals = { exposed }
      continue
    }
    const addonMatch = ADDON_PATTERN.exec(line)
    if (addonMatch === null) continue
    if (addon !== undefined) return undefined
    addon = { available: addonMatch[1] === 'true', version: addonMatch[2] ?? '' }
  }
  if (internals === undefined || addon === undefined) return undefined
  return { internalsExposed: internals.exposed, addonAvailable: addon.available, addonVersion: addon.version }
}
