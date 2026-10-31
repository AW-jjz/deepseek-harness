import { describe, expect, it } from 'vitest'
import { estimateContent, estimateTextTokens } from '@deepseek-ai/dsh-token-meter/estimate'

describe('estimateTextTokens', () => {
  it('keeps the four-characters-per-token density for ASCII', () => {
    expect(estimateTextTokens('')).toBe(0)
    expect(estimateTextTokens('a'.repeat(100))).toBe(25)
    expect(estimateTextTokens('hello world')).toBe(3)
  })

  it('prices each non-ASCII code point as a whole token', () => {
    // Four Han characters used to price as one token at the Latin density.
    expect(estimateTextTokens('你好世界')).toBe(4)
    expect(estimateTextTokens('日本語のテキスト')).toBe(8)
  })

  it('prices a mixed run by its script mix rather than its raw length', () => {
    // Six ASCII characters round to two tokens; two wide characters add two.
    expect(estimateTextTokens('hello 你好')).toBe(4)
  })

  it('counts one token per code point above the BMP', () => {
    // Two emoji occupy four UTF-16 units; the priced unit is the code point.
    expect(estimateTextTokens('👋👋')).toBe(2)
  })

  it('prices a text block from its content plus structural overhead', () => {
    expect(estimateContent([{ type: 'text', text: '你好世界' }])).toBe(8)
    expect(estimateContent([{ type: 'text', text: 'a'.repeat(100) }])).toBe(29)
  })
})
