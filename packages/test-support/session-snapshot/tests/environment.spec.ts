import { describe, expect, it } from 'vitest'
import { RECORDED_CORPUS_HOST_PLATFORMS, recordedCorpusEnvironment } from '../src/environment.ts'

describe('recordedCorpusEnvironment', () => {
  it('replays the committed corpora where they were recorded', () => {
    for (const platform of RECORDED_CORPUS_HOST_PLATFORMS) {
      expect(recordedCorpusEnvironment(platform), platform).toEqual({})
      expect(recordedCorpusEnvironment(platform, true), platform).toEqual({})
    }
  })

  it('names the environment difference instead of claiming a result on a foreign host', () => {
    const environment = recordedCorpusEnvironment('win32')
    expect(environment.skipReason).toContain('POSIX host')
    expect(environment.skipReason).toContain('win32')
    expect(environment.skipReason).toContain('bash')
  })

  it('refuses to skip the whole lane in CI, where a green report would be a lie', () => {
    expect(() => recordedCorpusEnvironment('win32', true)).toThrow(/CI must not run this lane on win32/u)
  })

  it('keeps an unmentioned platform foreign rather than assuming it matches', () => {
    expect(recordedCorpusEnvironment('aix').skipReason).toContain('aix')
    expect(recordedCorpusEnvironment('freebsd').skipReason).toContain('freebsd')
  })
})
