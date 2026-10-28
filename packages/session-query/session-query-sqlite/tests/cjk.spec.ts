/** CJK index and query terms: the bigrams that make a script without spaces searchable. */

import { describe, expect, it } from 'vitest'
import { cjkIndexTerms, cjkQuery, hasCjk, isCjkCodePoint } from '../src/cjk.ts'

describe('CJK detection', () => {
  it('recognizes the scripts written without spaces', () => {
    expect(isCjkCodePoint('磁'.codePointAt(0)!)).toBe(true)
    expect(isCjkCodePoint('あ'.codePointAt(0)!)).toBe(true)
    expect(isCjkCodePoint('한'.codePointAt(0)!)).toBe(true)
    expect(isCjkCodePoint('a'.codePointAt(0)!)).toBe(false)
    expect(isCjkCodePoint('1'.codePointAt(0)!)).toBe(false)
    expect(isCjkCodePoint('。'.codePointAt(0)!)).toBe(false)
    expect(hasCjk('ENOSPC: no space left')).toBe(false)
    expect(hasCjk('磁盘已满 ENOSPC')).toBe(true)
  })
})

describe('index terms', () => {
  it('emits unigrams and adjacent bigrams for one run', () => {
    expect(cjkIndexTerms('磁盘空间')).toBe('磁 盘 空 间 磁盘 盘空 空间')
    expect(cjkIndexTerms('错')).toBe('错')
  })

  it('keeps runs apart and ignores text that is already tokenized', () => {
    expect(cjkIndexTerms('磁盘 ENOSPC 已满')).toBe('磁 盘 磁盘 已 满 已满')
    expect(cjkIndexTerms('no space left')).toBe('')
    expect(cjkIndexTerms('')).toBe('')
  })
})

describe('query rewrite', () => {
  it('turns one word into its pair and a phrase into all pairs', () => {
    expect(cjkQuery('磁盘')).toBe('"磁" "盘" "磁盘"')
    expect(cjkQuery('磁盘空间')).toBe('"磁" "盘" "空" "间" "磁盘" "盘空" "空间"')
  })

  it('keeps ASCII words as inert phrases beside the CJK terms', () => {
    expect(cjkQuery('错误 ENOSPC')).toBe('"错" "误" "错误" "ENOSPC"')
    // A user's quote cannot break out of the phrase.
    expect(cjkQuery('错误 "ENOSPC"')).toBe('"错" "误" "错误" """ENOSPC"""')
  })
})
