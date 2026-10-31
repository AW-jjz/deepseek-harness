# Agent Note: Spill locators name a file inside a root, not an absolute path

Status: implemented

English | [中文](2026-10-31-spill-locator-schemes.zh.md)

## Problem

A spill notice hands the model a locator string, and that string is persisted into the session log — so its meaning has to survive longer than the process that wrote it. An absolute path survives a restart, but not a move: the harness home is a directory the user owns, and relocating a portable install or pointing `DSH_HOME` elsewhere leaves every stored locator pointing at a directory that no longer exists. The notice cannot fall back to a relative path either: `~` expands to the host user's home, which is unrelated to the harness home, and a path relative to the session working directory has no relationship to the spill root at all.

## Decision

A locator may name a file by its position **inside** a registered directory: `spill:/session-<hash>/<file>`. Two configuration halves, both derived from the same `dshHomePath('spill')` expression in the bundle, make it work. `spill-local` gains `locatorScheme`, which replaces the absolute path in every locator it writes and requires an explicit `root` (a private per-process temp root means nothing to a reader). The filesystem backend gains `locatorRoots`, each `{ scheme, root }`, and expands a matching request under the root configured **now** — in both `resolve` and `lstat`, before home expansion and relative anchoring.

Three properties keep the change safe rather than merely new. Both halves are opt-in, so a composition that sets only one keeps today's absolute locators instead of producing unresolvable handles. An absolute path never matches a scheme, so old logs keep working unchanged. And the relative remainder is containment-checked: a locator that climbs out of its root is refused rather than opened, because the only legitimate writer of a locator is the backend that owns the directory.

The search tools resolve the same scheme before spawning ripgrep. A locator is not a real path, and `grep`/`glob` hand their target to a subprocess, so passing it through unchanged would break a retrieval hint that explicitly recommends searching a spilled result.

## Alternatives considered

**Keep absolute locators and document the limitation.** Cheapest, and it was the state after the root became stable: restart-safe but not move-safe. The failure is silent and late — a model reads a stale locator weeks later and reports the file as missing — so the residual was worth closing once the root was already configurable.

**Write the root into the locator and rewrite stale prefixes at read time.** This makes the reader guess which part of a path is the movable part, and it cannot distinguish a moved root from a deleted one. A scheme names the contract instead of inferring it.

**Add a locator resolver to the filesystem seam as an abstract method or a new service.** Both put new vocabulary and a new lifecycle into `ctx.fs`, which every backend and composition implements. A configuration pair on the two packages that already own the two halves of the contract adds no service, no event, and no abstract method, so no third party breaks.

**Move resolution into the tool layer for `read` only.** It would leave `lstat`, `edit`, and every future consumer unhandled, and it would put the knowledge in a consumer rather than in the backend that owns path resolution.

## Consequences

A moved home keeps every locator written after the scheme shipped. Locators already written as absolute paths under a moved root cannot be recovered by any change here — the information about their root is simply not in the string.

The two halves must stay in step: the scheme name and the directory are duplicated in configuration, and `packages/bundle/base/tests/base.spec.ts` pins that both rows carry the same expression. A composition that sets `locatorScheme` without the matching `locatorRoots` entry produces locators its own reader cannot open, which is why the option is unset by default rather than inferred.

`%TEMP%\dsh-spill-*` roots from before the home-anchored root remain outside this contract; their locators are absolute and are handled by the existing discovery sweep, not by a scheme.
