/** Refuse writing committed snapshot fixtures on a platform other than the one that recorded the corpus. */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Platform whose committed snapshot fixtures record the shell and path shapes replayed elsewhere.
 *
 * Record and refresh both write back what a run produced: replayed session headers name the shell
 * that ran each tool, and a working directory keeps the form the recording platform used. Committing
 * that from another platform replaces goldens every platform replays. The working-directory quoting
 * fix made the corpus parse on Windows again, which turned that hazard from a loud parse error into a
 * silent write, so the refusal belongs at the command each write runs through.
 *
 * The file keeps its `refresh` name because committed notes reference it; the rule it states covers
 * record too, which is the wider write and was previously unguarded.
 */
const corpusPlatform: NodeJS.Platform = 'linux'

/**
 * Explain why this platform may not write committed snapshot fixtures.
 * @param platform - Platform a record or refresh would run on.
 * @returns The refusal message, or undefined on the platform that recorded the corpus.
 */
export function snapshotWritePlatformError(platform: NodeJS.Platform): string | undefined {
  if (platform === corpusPlatform) return undefined
  return `snapshot record and refresh are limited to ${corpusPlatform}; this is ${platform}. `
    + 'Both rewrite committed fixtures from what this run produced, and the corpus records the platform that '
    + 'produced it: replayed session headers name the shell that ran the tools and paths keep the recorded form. '
    + `Writing on ${platform} would commit ${platform} output into goldens every other platform replays. `
    + 'Replay is unaffected: run `pnpm run test:snapshot` (or `test:expected` / `test:web:built`) to diagnose here.'
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  const problem = snapshotWritePlatformError(process.platform)
  if (problem === undefined) {
    console.log(`assert-snapshot-refresh-platform: ${process.platform} may write committed fixtures.`)
  } else {
    console.error(`assert-snapshot-refresh-platform: ${problem}`)
    process.exitCode = 1
  }
}
