import { describe, expect, it } from 'vitest'
import { refreshPlatformError } from './assert-snapshot-refresh-platform.ts'

describe('snapshot refresh platform gate', () => {
  it('admits the platform that recorded the corpus', () => {
    expect(refreshPlatformError('linux')).toBeUndefined()
  })

  it.each(['win32', 'darwin'] as const)('refuses %s and names the replay command instead', (platform) => {
    const problem = refreshPlatformError(platform)
    expect(problem).toContain(`this is ${platform}`)
    expect(problem).toContain('pnpm run test:snapshot`')
    expect(problem).toContain('every other platform replays')
  })
})
