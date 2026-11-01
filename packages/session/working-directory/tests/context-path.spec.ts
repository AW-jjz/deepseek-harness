/** Unit tests for the runtime-context path quoting shared by the service and its expectations. */
import { describe, expect, it } from 'vitest'
import { quoteContextPath } from '../src/index.ts'

describe('quoteContextPath', () => {
  it('quotes a POSIX directory exactly as JSON does', () => {
    const directory = '/tmp/dsh-snapshot-cwd-ab12'
    expect(quoteContextPath(directory)).toBe(JSON.stringify(directory))
  })

  it('keeps a Windows directory readable instead of doubling every separator', () => {
    const directory = String.raw`C:\Users\24409\AppData\Local\Temp\sdk-snapshot`
    const quoted = quoteContextPath(directory)
    expect(quoted).toBe(String.raw`"C:\Users\24409\AppData\Local\Temp\sdk-snapshot"`)
    expect(quoted).not.toContain(String.raw`\\`)
  })

  it('preserves a UNC prefix as one separator pair', () => {
    expect(quoteContextPath(String.raw`\\server\share\dir`)).toBe(String.raw`"\\server\share\dir"`)
  })

  it('still escapes the quote character JSON has to escape', () => {
    expect(quoteContextPath('/tmp/quo"te')).toBe(String.raw`"/tmp/quo\"te"`)
  })
})
