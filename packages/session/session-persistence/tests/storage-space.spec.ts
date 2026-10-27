/** Storage admission vocabulary: thresholds, error-chain recognition, and the accounted message. */

import { describe, expect, it } from 'vitest'
import {
  STORAGE_BLOCK_BYTES,
  STORAGE_FULL_CODE,
  STORAGE_WARN_BYTES,
  StorageFullError,
  storageAdmission,
  storageExhaustion,
} from '../src/storage-space.ts'

const MB = 1024 * 1024
const GB = 1024 * MB

describe('storage admission', () => {
  it('refuses below the write margin, warns below the working threshold, and admits otherwise', () => {
    expect(storageAdmission(undefined)).toEqual({ level: 'ok', freeBytes: undefined })
    expect(storageAdmission(STORAGE_BLOCK_BYTES - 1)).toEqual({ level: 'full', freeBytes: STORAGE_BLOCK_BYTES - 1 })
    expect(storageAdmission(STORAGE_BLOCK_BYTES)).toEqual({ level: 'warning', freeBytes: STORAGE_BLOCK_BYTES })
    expect(storageAdmission(STORAGE_WARN_BYTES - 1)).toEqual({ level: 'warning', freeBytes: STORAGE_WARN_BYTES - 1 })
    expect(storageAdmission(STORAGE_WARN_BYTES)).toEqual({ level: 'ok', freeBytes: STORAGE_WARN_BYTES })
    expect(storageAdmission(16 * GB)).toEqual({ level: 'ok', freeBytes: 16 * GB })
  })

  it('keeps the write margin well below the warning so the failure itself always fits', () => {
    expect(STORAGE_BLOCK_BYTES).toBe(500 * MB)
    expect(STORAGE_WARN_BYTES).toBe(2 * GB)
  })
})

describe('storage exhaustion recognition', () => {
  it('recognizes a direct filesystem code', () => {
    expect(storageExhaustion(Object.assign(new Error('write failed'), { code: 'ENOSPC' }))).toBe('ENOSPC')
    expect(storageExhaustion(Object.assign(new Error('quota'), { code: 'EDQUOT' }))).toBe('EDQUOT')
  })

  it('follows cause and aggregate members to the exhausted write', () => {
    const inner = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
    const wrapped = new Error('could not append', { cause: new AggregateError([new Error('flush'), inner]) })
    expect(storageExhaustion(wrapped)).toBe('ENOSPC')
  })

  it('leaves every other failure alone', () => {
    expect(storageExhaustion(new Error('boom'))).toBeUndefined()
    expect(storageExhaustion(Object.assign(new Error('nope'), { code: 'EACCES' }))).toBeUndefined()
    expect(storageExhaustion(undefined)).toBeUndefined()
    expect(storageExhaustion('ENOSPC')).toBeUndefined()
  })

  it('terminates on a self-referential chain', () => {
    const looped: { cause?: unknown; code?: string } = { code: 'EIO' }
    looped.cause = looped
    expect(storageExhaustion(looped)).toBeUndefined()
  })
})

describe('StorageFullError', () => {
  it('carries the stable code and names the reading it refused on', () => {
    const error = new StorageFullError(120 * MB)
    expect(error.code).toBe(STORAGE_FULL_CODE)
    expect(error.freeBytes).toBe(120 * MB)
    expect(error.message).toContain('120 MB free')
    expect(error.message).toContain('500 MB')
  })

  it('renders gigabytes with one decimal and stays honest without a reading', () => {
    expect(new StorageFullError(1.25 * GB).message).toContain('1.3 GB')
    expect(new StorageFullError().message).toBe('the session store has no free space')
  })
})
