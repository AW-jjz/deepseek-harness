/**
 * Default worker budget shared by repository gates, builds, linters, and Vitest configurations.
 *
 * In CI (`CI=true`) the budget is the CPU count Node reports for the runner. Elsewhere it is capped at
 * {@link LOCAL_PARALLELISM_CAP}, or {@link LOCAL_TEST_PARALLELISM_CAP} for Vitest forks, because
 * `os.availableParallelism()` reports host CPUs rather than a container's CPU quota and local runs share
 * the workstation. Each tool's explicit override
 * (`DSH_GATE_CONCURRENCY`, `DSH_OXLINT_THREADS`, `DSH_COVERAGE_MAX_WORKERS`, `--maxWorkers`) still wins.
 */

import { availableParallelism } from 'node:os'

/** Largest default worker count outside CI. */
export const LOCAL_PARALLELISM_CAP = 12

/**
 * Largest default Vitest fork count outside CI, for coverage runs.
 *
 * This is the *budget* handed to coverage; see {@link LOCAL_VITEST_FORK_CAP} for the fork count
 * plain test runs use.
 */
export const LOCAL_TEST_PARALLELISM_CAP = 48

/**
 * Largest default fork count outside CI for plain (non-coverage) test runs.
 *
 * Lower than {@link LOCAL_TEST_PARALLELISM_CAP} on purpose: a fork is not a cheap unit. Many
 * `apps/desktop` suites spawn real processes (pwsh, signtool, cl.exe, Electron) or walk the whole
 * workspace, so beyond the physical budget they spend their time queueing on the disk and trip the
 * 5 s default test budget. At 48 forks the desktop suite fails a different handful of cases on every
 * run — a case that takes 1.4 s alone has been observed at 9.9 s — while at 12 it is green and about
 * 30% faster in wall clock (24 s vs 34 s for 171 files).
 */
export const LOCAL_VITEST_FORK_CAP = 12

/**
 * Resolve the default worker budget for one process.
 * @param env - Environment whose `CI` value selects the CI budget.
 * @param available - CPU count Node reports for this process.
 * @param cap - Local cap; {@link LOCAL_TEST_PARALLELISM_CAP} for Vitest forks.
 * @returns `available` in CI, otherwise `available` capped at `cap`.
 */
export function defaultParallelism(
  env: NodeJS.ProcessEnv = process.env,
  available: number = availableParallelism(),
  cap: number = LOCAL_PARALLELISM_CAP,
): number {
  return env.CI === 'true' ? available : Math.min(available, cap)
}

/**
 * Describe a default worker budget for scheduler and tool start lines.
 * @param env - Environment whose `CI` value selects the CI budget.
 * @param available - CPU count Node reports for this process.
 * @returns The budget and where it came from, for example `12 local default worker(s) of 256 CPU(s)`.
 */
export function describeDefaultParallelism(env: NodeJS.ProcessEnv = process.env, available: number = availableParallelism()): string {
  return env.CI === 'true'
    ? `${String(available)} available CPU(s)`
    : `${String(defaultParallelism(env, available))} local default worker(s) of ${String(available)} CPU(s)`
}
