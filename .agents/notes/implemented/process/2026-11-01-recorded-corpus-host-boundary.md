# Agent Note: A recorded corpus declares the host it reproduces

Status: implemented

English | [中文](2026-11-01-recorded-corpus-host-boundary.zh.md)

## Problem

The recorded-session lane failed almost everywhere on a Windows checkout: 126 of 174 tests in the headless corpus, every one of the 31 TypeScript SDK scenarios, and 2 of the 8 ACP scenarios. Nothing in the product had regressed. Two facts of the host environment travel inside a recording, and both differ on Windows:

- the shell tool. A pinned request header carries the complete tool catalog the host assembled, so the recording names `bash` with its own description and parameter schema, while a Windows host presents `pwsh` with a different description, a different parameter set, and a different parameter order.
- the bundled skill catalog. A session records the catalog row it started with, and Windows bundles a skill no other host has, so every session on Windows carries one row the recording does not.

A replay on such a host compares two environments and reports the difference as a regression. It also hid a second hazard: `test:snapshot:record` had no platform guard at all, so a Windows developer could have committed a Windows corpus into goldens every other platform replays.

## Decision

The corpora declare the host environment they reproduce, once, and the lane refuses to claim coverage outside it.

`recordedCorpusEnvironment` in the snapshot support package returns a skip reason for any platform outside `linux`/`darwin`, and throws instead when the process runs in CI — a lane that silently skips its whole corpus still reports green, so CI must fail rather than skip. The three corpus files fold that reason into their existing per-scenario skip decisions; the ACP corpus passes it through the suite option `environmentSkipReason` because that corpus is registered by the suite factory. Each file prints the reason once, so the skip is visible in the run output rather than inferred from a count.

The write side uses the narrower rule already in place: `test:snapshot:record` now runs the same platform script as the three refresh scripts, so both write commands are refused outside the platform that recorded the corpus. Record is the wider write and was previously unguarded.

## Alternatives considered

- **Mark every scenario `platform: posix`.** Tried first on the 31 SDK manifests: the manifest key already exists and its semantics fit. Rejected as the whole answer because the corpus needs 199 of them, the marks are inert on every supported platform, and a new scenario silently omits one. The per-scenario key stays the right tool for a single scenario inside a portable corpus.
- **Normalize the shell tool slot in the comparison.** It repairs the pinned-header diff and leaves the skill-catalog row, the recorded script that invokes `bash`, and the tool-availability diagnostic untouched — so it would have required a second normalization for each of them, each one deleting evidence from the comparison to keep the run green.
- **Re-record a Windows corpus.** Recording is the only honest way to claim Windows coverage, and it needs a live API key for 199 scenarios, doubles the committed corpus, and would put Windows fixtures in a repository whose required lane is POSIX.
- **Leave the failures in place.** The lane then reports 159 red assertions on a Windows checkout that no one can act on, which teaches everyone to ignore the lane's verdict entirely.

## Consequences

On a Windows checkout `pnpm run test:snapshot` now reports 26 passed, 199 skipped, 0 failed and prints the reason for each corpus; the 26 are the fixture-invariant tests that read committed files without booting a session. On `linux` and `darwin` nothing changes: the predicate returns no reason, so every skip decision is what it was. A CI runner on a foreign platform fails loudly instead of skipping.

The claim this lane makes is now narrow and checkable: it verifies the corpora on the hosts that reproduce them, and it says so elsewhere. Windows loses the incidental coverage of the 5 subprocess scenarios that happened to pass there, and the ACP corpus loses 6; both are a price for a boundary that does not rot as new platform-conditional capabilities appear.

`test:snapshot:record` and the three refresh scripts now share one refusal, so the fixture-writing surface has a single platform rule instead of one guarded path and one unguarded path.
