import { describe, expect, it } from 'vitest'
import { RENDERER_RELOAD_LIMIT, decideRendererFailure } from '../src/renderer-recovery.ts'

const base = {
  quitting: false, destroyed: false, sessionEnding: false,
  reason: 'crashed', recoverable: true, reloadsLeft: RENDERER_RELOAD_LIMIT,
}

describe('renderer failure handling', () => {
  it('reloads a crashed renderer while the budget lasts', () => {
    expect(decideRendererFailure(base)).toBe('recover')
    expect(decideRendererFailure({ ...base, reloadsLeft: 1 })).toBe('recover')
  })

  it('reports a crash loop as fatal once the budget is spent', () => {
    expect(decideRendererFailure({ ...base, reloadsLeft: 0 })).toBe('fatal')
  })

  it('does not reload a failure a reload cannot fix', () => {
    expect(decideRendererFailure({ ...base, reason: 'preload-error', recoverable: false })).toBe('fatal')
  })

  it('only records the failure while the operating system ends the session', () => {
    // A modal box here would stall the shutdown the OS is waiting on.
    expect(decideRendererFailure({ ...base, sessionEnding: true })).toBe('report-only')
    expect(decideRendererFailure({ ...base, sessionEnding: true, reloadsLeft: 0 })).toBe('report-only')
  })

  it('ignores a clean exit and any failure while quitting or after the window is gone', () => {
    expect(decideRendererFailure({ ...base, reason: 'clean-exit' })).toBe('ignore')
    expect(decideRendererFailure({ ...base, quitting: true })).toBe('ignore')
    expect(decideRendererFailure({ ...base, destroyed: true })).toBe('ignore')
  })
})
