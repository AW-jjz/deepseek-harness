# Agent Note: Token pricing reads the script mix, not just the length

Status: implemented

English | [中文](2026-10-31-cjk-aware-token-density.zh.md)

## Problem

The fixed heuristic priced every four characters of text as one token, and it counted UTF-16 units, so a Chinese sentence costing roughly one token per character was measured at about a quarter of its real price. Two mechanisms read that number on every turn: compaction decides when to fold the context, and the spill policy decides which tool result is too large to inline. Both therefore fired four times too late on CJK content — the failure lands as a provider rejecting an oversized request, after the session has already been written that way.

The defect was recorded as P0-scale noise for Chinese users (P1-30 in the v8.2 ledger): `CHARS_PER_TOKEN = 4` with `maxInlineTokens: 12500` unchanged, and the package README admitted in its own limitations that "CJK text and JSON schemas underprice badly at four characters per token".

## Decision

Pricing walks the text once and classifies each code point: ASCII keeps the four-characters-per-token density, and every other code point costs one whole token. Latin text therefore prices exactly as before, while Chinese, Japanese, Korean, and other wide scripts move to roughly one token per character — the order of magnitude a real tokenizer gives them.

The classification lives in one exported helper, `estimateTextTokens`, and every text arm of the heuristic calls it: text and reasoning blocks, tool-call names and arguments, the system prompt, and the `JSON.stringify` paths for structural blocks and tool schemas. Keeping one implementation is what preserves the existing contract that the meter service and the context-breakdown projection price identical content to identical numbers.

Overpricing is the safe direction. A heuristic that guesses high compacts early and spills early; a heuristic that guesses low discovers the error at the provider.

## Alternatives considered

**Per-provider exact tokenizers.** The correct long-term answer, and the reason the source map still describes a heuristic. It needs a tokenizer implementation and its vocabulary per route, in a package that currently has no dependencies beyond types, and it would change replay stability unless the vocabulary is pinned and versioned alongside the log. Not worth bundling before a provider exposes token counting we can trust.

**A fixed ratio for wide scripts, such as 1.5 characters per token.** Closer to some tokenizers on prose and wrong on identifiers, punctuation, and mixed code. A per-code-point price needs no calibration and never undercuts the ASCII arm.

**A configuration knob for the density.** Nobody can set it correctly from the outside; the value depends on the script of the content, which the meter sees and the operator does not.

## Consequences

CJK-heavy sessions now compact sooner and spill larger tool results earlier, which is the intended trade: the budget is spent before the request fails, not after.

Accented Latin, Cyrillic, Greek, and symbol-heavy text now overprice by up to four times, and emoji price at one token each regardless of how the provider splits them. That is accepted overpricing in the conservative direction, and the README limitations section states it.

Nothing re-priced in the recorded test corpora: every fixture in the token-meter, compaction, spill, and tool-web suites is ASCII, so the change is numerically invisible to them — the guards that would catch a drift are the new `tests/estimate.spec.ts` cases and the per-file coverage gate.
