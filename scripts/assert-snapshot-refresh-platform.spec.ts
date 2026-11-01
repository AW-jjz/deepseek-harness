import { describe, expect, it } from 'vitest'
import { snapshotWritePlatformError } from './assert-snapshot-refresh-platform.ts'

describe('snapshot write platform gate', () => {
  it('admits the platform that recorded the corpus', () => {
    expect(snapshotWritePlatformError('linux')).toBeUndefined()
  })

  it.each(['win32', 'darwin'] as const)('refuses %s and names the replay command instead', (platform) => {
    const problem = snapshotWritePlatformError(platform)
    expect(problem).toContain(`this is ${platform}`)
    expect(problem).toContain('pnpm run test:snapshot`')
    expect(problem).toContain('every other platform replays')
  })

  it('refuses record as well as refresh, since both write the corpus', () => {
    expect(snapshotWritePlatformError('win32')).toContain('record and refresh')
  })
})
