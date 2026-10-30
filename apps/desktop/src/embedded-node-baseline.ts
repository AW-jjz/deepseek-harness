/**
 * The Node security baseline this desktop must ship, and the gate that refuses a build below it.
 *
 * Electron bundles its own Node, so the Node version a packaged build runs is a property of the
 * Electron pin, not of a manifest field anyone reads. Node's 2026-10-21 security release fixed
 * eight advisories, four rated High, inside the 24.22 line; Electron embedded 24.22.0 until
 * 44.10.0, which means the pin — not the code — decides whether those fixes are present. Nothing
 * in the source records that, and nothing about a lower pin looks wrong in review: the version
 * number is one patch off, and the artifact still builds, starts and passes the suite.
 *
 * `apps/desktop/scripts/package-target.ts` probes the embedded version from the Electron binary
 * the install actually downloaded and runs this gate against it, so the answer comes from the
 * runtime rather than from a table that could drift out of step with the pin.
 */

/** Lowest embedded Node version this repository ships: Node's 2026-10-21 security release. */
export const EMBEDDED_NODE_BASELINE = '24.22.1'

/** One version's numeric parts, plus whether it is a prerelease. */
interface ParsedNodeVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: boolean
}

/**
 * Parse a Node version string of the `major.minor.patch` form the runtime reports.
 *
 * A leading `v` is tolerated because both Node and Electron print one, and a prerelease suffix is
 * recorded rather than rejected: `24.22.1-rc.1` is a version this gate must judge as *below*
 * 24.22.1, which is only expressible if the suffix is kept.
 * @param value - Version string from a runtime probe or a manifest.
 * @returns The parsed parts, or undefined when the string is not a version.
 */
function parseNodeVersion(value: string): ParsedNodeVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+](?<rest>.*))?$/u.exec(value.trim())
  if (match === null) return undefined
  const major = match[1]
  const minor = match[2]
  const patch = match[3]
  if (major === undefined || minor === undefined || patch === undefined) return undefined
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: match.groups?.rest !== undefined,
  }
}

/**
 * Order two versions the way Node publishes them.
 * @param left - First version, already parsed.
 * @param right - Second version, already parsed.
 * @returns Negative when left is older, zero when equal, positive when newer.
 */
function compareParsed(left: ParsedNodeVersion, right: ParsedNodeVersion): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  if (left.patch !== right.patch) return left.patch - right.patch
  // A prerelease precedes the release it leads to.
  if (left.prerelease === right.prerelease) return 0
  return left.prerelease ? -1 : 1
}

/** Everything the gate needs to decide. */
export interface EmbeddedNodeGateInput {
  /** Node version the Electron binary reports under `ELECTRON_RUN_AS_NODE`. */
  readonly embeddedNodeVersion: string
  /** Baseline to judge against; defaults to the shipped one. */
  readonly baseline?: string
}

/** The gate's answer, including why, so a packaging log line can quote it. */
export interface EmbeddedNodeGateVerdict {
  /** True when the embedded Node is at or above the baseline. */
  readonly ok: boolean
  /** One sentence naming the versions and, when failing, what to change. */
  readonly reason: string
}

/**
 * Judge an embedded Node version against the security baseline.
 *
 * A version the gate cannot parse fails rather than passing quietly: the probe's output is the
 * only evidence the build has, and "unrecognised" must not read as "acceptable".
 * @param input - Embedded version and the baseline to judge it against.
 * @returns The verdict, including a sentence for the packaging log.
 */
export function evaluateEmbeddedNodeBaselineGate(input: EmbeddedNodeGateInput): EmbeddedNodeGateVerdict {
  const baseline = input.baseline ?? EMBEDDED_NODE_BASELINE
  const embedded = parseNodeVersion(input.embeddedNodeVersion)
  if (embedded === undefined) {
    return {
      ok: false,
      reason: `the Electron binary reported ${JSON.stringify(input.embeddedNodeVersion)} as its Node version, `
        + `which is not a version this gate can compare with the ${baseline} baseline`,
    }
  }
  const floor = parseNodeVersion(baseline)
  if (floor === undefined) throw new Error(`embedded node baseline: ${JSON.stringify(baseline)} is not a version`)
  if (compareParsed(embedded, floor) >= 0) {
    return {
      ok: true,
      reason: `embedded Node ${input.embeddedNodeVersion} meets the ${baseline} security baseline`,
    }
  }
  return {
    ok: false,
    reason: `the packaged runtime would embed Node ${input.embeddedNodeVersion}, below the ${baseline} security baseline `
      + '(Node\'s 2026-10-21 release; four of its eight advisories are rated High); pin an Electron release that '
      + `embeds ${baseline} or later`,
  }
}

/**
 * The gate as packaging calls it: throw rather than return, so the build stops before any
 * artifact exists.
 * @param input - Embedded version and the baseline to judge it against.
 * @returns The passing verdict, for a log line.
 */
export function assertEmbeddedNodeBaselineGate(input: EmbeddedNodeGateInput): EmbeddedNodeGateVerdict {
  const verdict = evaluateEmbeddedNodeBaselineGate(input)
  if (!verdict.ok) throw new Error(`desktop embedded node: ${verdict.reason}`)
  return verdict
}
