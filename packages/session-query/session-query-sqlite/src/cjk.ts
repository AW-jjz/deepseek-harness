/**
 * CJK retrieval for the FTS5 index.
 *
 * `unicode61` splits on spaces and punctuation and treats a run of CJK
 * ideographs as one token, so a document containing 没有磁盘空间 indexes as a
 * single unsearchable token and 磁盘 (the word a person types) matches nothing.
 * The index therefore carries a second column of CJK **unigrams and bigrams**,
 * and a query's CJK runs are rewritten into the same bigrams: 磁盘 matches the
 * 磁盘 token, 磁盘空间 matches 磁盘 AND 盘空 AND 空间 — a conjunction of adjacent
 * pairs, which is what a substring search means for a script without spaces.
 *
 * The column holds nothing for text with no CJK, so ASCII indexes are unchanged
 * in size. Snippets still come from the display column, where a CJK query marks
 * no characters: a Chinese result shows the head of its text rather than a
 * highlighted fragment.
 * @module @deepseek-ai/dsh-session-query-sqlite/cjk
 */

/** Code-point ranges whose scripts run without word-separating spaces. */
const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x2E80, 0x2EFF], // CJK radicals
  [0x3040, 0x30FF], // Hiragana, Katakana
  [0x3400, 0x4DBF], // CJK Unified Ideographs Extension A
  [0x4E00, 0x9FFF], // CJK Unified Ideographs
  [0xAC00, 0xD7AF], // Hangul Syllables
  [0xF900, 0xFAFF], // CJK Compatibility Ideographs
  [0x20000, 0x2FA1F], // CJK Extensions B–F and compatibility supplement
]

/**
 * Whether one code point belongs to a script written without spaces.
 * @param code - Unicode code point.
 * @returns true for CJK ideographs, kana, and Hangul syllables.
 */
export function isCjkCodePoint(code: number): boolean {
  for (const [start, end] of CJK_RANGES) {
    if (code >= start && code <= end) return true
  }
  return false
}

/**
 * Whether one text contains any CJK, which is what switches the query rewrite on.
 * @param text - the user's query.
 * @returns true when the query needs the bigram rewrite.
 */
export function hasCjk(text: string): boolean {
  for (const character of text) {
    if (isCjkCodePoint(character.codePointAt(0) ?? 0)) return true
  }
  return false
}

/** Quote one ASCII word as an FTS5 phrase so query syntax stays inert. */
function phrase(word: string): string {
  return `"${word.replaceAll('"', '""')}"`
}

/** Tokens for one run: every character once, then every adjacent pair. */
function runTerms(run: readonly string[]): string[] {
  if (run.length === 1) return [run[0] as string]
  const terms = [...run]
  for (let index = 0; index + 1 < run.length; index += 1) {
    terms.push(`${run[index] as string}${run[index + 1] as string}`)
  }
  return terms
}

/**
 * Bigram/unigram terms the index needs for the CJK content of one text.
 *
 * Non-CJK text contributes nothing: it is already tokenized by unicode61.
 * @param text - normalized document text.
 * @returns space-separated terms, empty when the text has no CJK.
 */
export function cjkIndexTerms(text: string): string {
  const terms: string[] = []
  let run: string[] = []
  const flush = (): void => {
    if (run.length === 0) return
    terms.push(...runTerms(run))
    run = []
  }
  for (const character of text) {
    if (isCjkCodePoint(character.codePointAt(0) ?? 0)) run.push(character)
    else flush()
  }
  flush()
  return terms.join(' ')
}

/**
 * Rewrite a query so its CJK runs match the bigram column.
 *
 * Each run becomes its terms ANDed together, each quoted so FTS5 treats it as
 * one token; the surrounding ASCII words keep their own syntax.
 * @param query - the user's query after FTS sanitization.
 * @returns the query to bind to `MATCH`.
 */
export function cjkQuery(query: string): string {
  const parts: string[] = []
  let run: string[] = []
  let word = ''
  const flushRun = (): void => {
    if (run.length === 0) return
    for (const term of runTerms(run)) parts.push(`"${term}"`)
    run = []
  }
  const flushWord = (): void => {
    if (word === '') return
    parts.push(phrase(word))
    word = ''
  }
  for (const character of query) {
    if (isCjkCodePoint(character.codePointAt(0) ?? 0)) {
      flushWord()
      run.push(character)
      continue
    }
    if (run.length > 0) flushRun()
    if (/\s/u.test(character)) flushWord()
    else word += character
  }
  flushRun()
  flushWord()
  return parts.join(' ')
}
