/**
 * The host environment a committed recorded-session corpus reproduces.
 *
 * A recorded scenario is an environment fingerprint as much as a transcript:
 * its pinned request header carries the tool catalog the host assembled, and
 * its persisted session log carries the rows a session started with. Two facts
 * in that catalog are chosen by the host, not by the code under test:
 *
 * - the shell tool, `bash` on a POSIX host and `pwsh` on Windows, with a
 *   different name, description, and parameter schema;
 * - the bundled skill catalog, which gains Windows-only entries on Windows.
 *
 * Replaying a POSIX recording on a Windows host therefore compares two
 * different environments and fails on the difference rather than on a
 * regression. Recording is what would make a Windows corpus possible, so the
 * corpora stay POSIX-bound until someone re-records them; this module states
 * that boundary once, in code, instead of leaving it to prose.
 */

/** Hosts whose shell tool and bundled skill catalog match the committed corpora. */
export const RECORDED_CORPUS_HOST_PLATFORMS: readonly NodeJS.Platform[] = ['linux', 'darwin']

/** One corpus file's decision about the host it is running on. */
export interface RecordedCorpusEnvironment {
  /**
   * Why every run test in this corpus must be skipped, or `undefined` when the
   * host reproduces the recorded environment.
   */
  readonly skipReason?: string
}

/**
 * Decide whether this host can replay a committed recorded-session corpus.
 *
 * Outside CI a foreign host skips: a developer on Windows keeps the corpus on
 * disk and runs every other tier, but no snapshot result is claimed there. In
 * CI a foreign host is an error rather than a skip, because a lane that
 * silently skips its whole corpus still reports green.
 *
 * @param platform The running Node platform, injectable for unit coverage.
 * @param ci Whether this process runs in CI; a foreign host throws instead of skipping.
 * @returns The skip decision for the caller's corpus files.
 */
export function recordedCorpusEnvironment(
  platform: NodeJS.Platform = process.platform,
  ci: boolean = false,
): RecordedCorpusEnvironment {
  if (RECORDED_CORPUS_HOST_PLATFORMS.includes(platform)) return {}
  const reason = `recorded-session corpora reproduce a POSIX host (${RECORDED_CORPUS_HOST_PLATFORMS.join('/')}): `
    + `a ${platform} host swaps the bash tool for its own shell tool and extends the bundled skill catalog, `
    + 'so a replay here compares two environments instead of detecting a regression'
  if (ci) {
    throw new Error(`${reason}; CI must not run this lane on ${platform}. Run it on a POSIX image, or re-record the corpus.`)
  }
  return { skipReason: reason }
}
