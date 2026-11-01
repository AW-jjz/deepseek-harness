# Agent Note: The runtime-context directory is quoted, not JSON-encoded

Status: implemented

English | [中文](2026-10-31-context-path-quoting.zh.md)

## Problem

Two layers were collapsed into one, and the collapse only shows on Windows.

The runtime-context line handed to the model read `Current working directory: "C:\\Users\\…"` — `JSON.stringify` around the directory supplies the quotes, and it also doubles every backslash. A POSIX directory needs no escaping, so the difference was invisible for the whole life of the corpus; on Windows the model was told a path no tool resolves. The same string was then reused as the recorded fixture's placeholder contract: replay splices the run's real directory into `{{cwd}}` with a plain `replaceAll`, which is correct for `/tmp/…` and produces `\A` — an illegal JSON escape — for `C:\…`. Every replay of a fixture holding the token died at `JSON.parse(line)` with `Bad escaped character`, on a Windows checkout only.

The second defect was latent behind the first: once the line parsed, the recorded `{{cwd}}` could no longer be recognized, because the run reported `C:\\…` (doubled) while the normalizer knows the plain spelling.

## Decision

The token is quoted **once**, for the layer that consumes it.

`quoteContextPath` (in `working-directory`) renders the directory the model reads: double quotes for readability, `\"` for a path that contains a quote, and single separators — `JSON.stringify(path).replaceAll('\\\\', '\\')`. A POSIX directory renders byte-identically to before, so no existing expectation moved.

`hydrateSessionFixtureCwd` (in `session-snapshot`, beside the tokenizer it inverts) splices the directory back into a fixture **JSON-escaped**, because the token always sits inside a JSON string literal: `text.replaceAll('{{cwd}}', JSON.stringify(path).slice(1, -1))`. The two functions are not opposites of each other; each is the correct spelling for its own layer.

The `minimal-image-compaction` scenario pads its temporary directory to fix the *rendered* length of that line at 192 characters, so it now measures through `quoteContextPath` too. On POSIX nothing changes; on Windows the padding tracks the text that actually ships.

## Alternatives considered

**Keep `JSON.stringify` and teach the normalizer the escaped spelling as well.** This turns the suite green while the model keeps reading `C:\\Users\\…`: green bought by suppressing the signal rather than by fixing it. The corpus exists to make platform differences visible, so the leak belongs in the product.

**Pin the real temporary directory in fixtures instead of a token.** The path differs on every run and every machine, so the fixture would never replay.

**Normalize the shell tool when comparing session headers, so one corpus serves both platforms.** This is the shape the remaining Windows red wants — `session-resume` now fails at the header because the recorded header lists `bash` and this machine mounts `pwsh` — but it changes comparison semantics for every corpus, and a header that silently drops the tool a session actually had is a weaker pin. It stays an open decision rather than a rider on this fix.

## Consequences

A Windows session now shows the same single-separator directory the tools resolve, and a Windows checkout replays `{{cwd}}` fixtures at all. The doubled form survives nowhere: no expectation, fixture, or locale string still builds the text with `JSON.stringify`.

`pnpm run test:snapshot` on Windows is not green yet, and that is now a corpus-design boundary rather than a parse failure: `session-resume` reaches the session-log comparison (records, runtime context, sidecars all match) and stops at the header's tool list, `bash` versus `pwsh`. The ACP corpora pin the same shell tool, so a Windows-green corpus needs either a platform-neutral shell entry or a per-platform corpus — decide before recording on Windows.

The test-support side gains a pure function with the tokenizer's doc and tests both ways (a Windows directory round-trips through `JSON.parse`, a POSIX one is unchanged, a fixture without the token is byte-identical).
