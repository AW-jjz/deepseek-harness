# Agent Note: Two gates now say what they cannot read

Status: implemented

English | [中文](2026-11-01-gate-boundaries.zh.md)

## Problem

Two repository gates fired on lines that are not what they were written to catch, and in one case the fix was not to change the line.

`verify-repository-references` rejects a commit identifier pasted into a maintained file. It finds candidates as runs of 7–40 hexadecimal characters that resolve to exactly one object in the local database, so a **decimal number** can qualify: `python/sdk/uv.lock:113` records `size = 6344383` for a Pillow wheel, and that number happens to be a unique prefix of a commit. The finding is real by the gate's own rule and meaningless as a reference — nobody pins a wheel size to a commit. It also makes the gate's verdict depend on which objects a clone happens to hold.

`test:snapshot:refresh` rewrites committed snapshot fixtures from whatever the current run produced. On Windows that run produces different bytes: the session headers name `pwsh` where the corpus recorded `bash`, and paths keep the recorded platform's form. Until the working-directory quoting fix, the hazard was masked — the corpus failed to parse on Windows, so refresh could not get far enough to write. With parsing fixed, the same command would silently commit Windows output into goldens every other platform replays.

## Decision

Each gate states the reading it declines, instead of inferring it.

**A decimal-only run is a number.** `isCommitShaped` requires an abbreviated candidate to contain a letter, so `6344383` is a size and `6344383a` is a reference. A complete identifier stays unambiguous — every digit of a 40-digit SHA-1 falling in 0–9 is a `(10/16)^40` accident — so a pasted full hash is still rejected. The accepted miss is stated rather than hidden: a 7-character all-decimal abbreviation would pass, and no shape rule can separate it from the numbers this gate must not read.

**A refresh runs where the corpus was recorded.** `scripts/assert-snapshot-refresh-platform.ts` runs ahead of the three refresh scripts and exits 1 on any platform but `linux`, naming the replay commands that work anywhere. There is no environment override: the constant is the one visible line to edit if the corpus ever moves, which is the same friction the error-code gate keeps for its own count.

## Alternatives considered

- **Exclude lockfiles from the reference gate.** It fits this instance and not the class: a decimal field in a table, a chart, or a JSON fixture collides the same way, and exempting lockfiles would stop catching a genuine hash pasted into one.
- **Require a minimum candidate length.** Wheel sizes reach eight digits and counts reach twelve, so a threshold either still collides or starts ignoring real short forms.
- **Compare the platform inside `vitest.snapshot.config.ts`.** Unit tests call the suite with an explicit `mode: 'refresh'`; a config-level refusal would either miss them or break them, while the scripts are exactly the surface a human refreshes through.
- **Make refresh normalize the platform away.** The header is the record of which tools a session had, and the corpus's value is that a replay is compared against what actually ran; normalizing it would delete the evidence to keep the writer.

## Consequences

The reference gate no longer depends on the accidental contents of one clone's object database for decimals, and it reports a smaller set of findings: an all-decimal short form is now invisible to it, which is recorded here rather than discovered later as a surprise.

The refresh scripts fail fast instead of rewriting goldens: on a Windows checkout the first command in the chain prints the reason and exits 1 before Vitest starts. Anyone who does need to refresh must do it on Linux or edit the constant, and that edit is a reviewable diff.

Both gates keep their corpus-wide forms unchanged, so `doc-sync` and CI read the same policy a contributor does.

## Evidence

- `scripts/verify-repository-references.spec.ts` covers the decimal field, the same value with a letter, and a brute-forced commit whose seven-digit prefix is all decimal (`git cat-file -t` confirms the object is a commit, and the scan reports nothing).
- `scripts/assert-snapshot-refresh-platform.spec.ts` fixes the admitted platform and the refusal text.
- On Windows, `npm run test:snapshot:refresh` exits 1 before Vitest starts, and `git status` shows no fixture write.
