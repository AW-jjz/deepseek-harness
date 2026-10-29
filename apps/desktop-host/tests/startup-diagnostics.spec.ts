import { describe, expect, it } from 'vitest'
import {
  inspectInternalsBridge, parseStartupDiagnosticLines, startupDiagnosticLines,
} from '../src/startup-diagnostics.ts'

/** The exposed form of the internals line, written out so a wording change fails here first. */
const EXPOSED_LINE = 'internals exposed: true  reason: R-16 addon bridge; expires 2027-01-24'

/** The flagless form: no reason suffix, because the flag is not the cause of exposure. */
const FLAGLESS_LINE = 'internals exposed: false'

/** The addon line for one probe answer. */
const addonLine = (available: boolean, version: string): string =>
  `addon available: ${available}  version: ${version}  via: direct requireBuiltin probe`

/** A loader that answers the two module ids the probe asks for. */
function loader(options: { readonly version?: unknown; readonly addon?: unknown } = {}): (moduleId: string) => unknown {
  return (moduleId: string) => {
    if (moduleId === 'node-addon-require-builtin/package.json') {
      if (options.version === undefined) throw new Error('exports map hides package.json')
      return options.version
    }
    if (options.addon === undefined) throw new Error('addon not installed')
    return options.addon
  }
}

describe('startup diagnostic lines', () => {
  it('renders both lines byte for byte', () => {
    expect(startupDiagnosticLines({ internalsExposed: true, addonAvailable: false, addonVersion: '0.1.9' }))
      .toEqual([EXPOSED_LINE, addonLine(false, '0.1.9')])
    expect(startupDiagnosticLines({ internalsExposed: false, addonAvailable: true, addonVersion: '0.1.9' }))
      .toEqual([FLAGLESS_LINE, addonLine(true, '0.1.9')])
  })
})

describe('inspectInternalsBridge', () => {
  it('reports a loading addon and the manifest version', () => {
    const addon = { requireBuiltin: (moduleId: string) => ({ moduleId }) }
    const diagnostics = inspectInternalsBridge(['--expose-internals'], loader({ version: { version: '0.1.9' }, addon }))
    expect(diagnostics).toEqual({
      internalsExposed: true,
      addonAvailable: true,
      addonVersion: '0.1.9',
      lines: [EXPOSED_LINE, addonLine(true, '0.1.9')],
    })
  })

  it('reports an unavailable addon when the module cannot load', () => {
    const diagnostics = inspectInternalsBridge(['--expose-internals'], loader())
    expect(diagnostics.addonAvailable).toBe(false)
    expect(diagnostics.addonVersion).toBe('unknown')
    expect(diagnostics.lines).toEqual([EXPOSED_LINE, addonLine(false, 'unknown')])
  })

  it('keeps an unknown version when only the manifest is hidden', () => {
    const addon = { requireBuiltin: () => ({}) }
    const diagnostics = inspectInternalsBridge([], loader({ addon }))
    expect(diagnostics.internalsExposed).toBe(false)
    expect(diagnostics.addonAvailable).toBe(true)
    expect(diagnostics.lines).toEqual([FLAGLESS_LINE, addonLine(true, 'unknown')])
  })

  it('treats an undefined requireBuiltin answer as unavailable', () => {
    const addon = { requireBuiltin: () => undefined }
    const diagnostics = inspectInternalsBridge(['--inspect=127.0.0.1:9'], loader({ version: { version: '0.1.9' }, addon }))
    expect(diagnostics.internalsExposed).toBe(false)
    expect(diagnostics.addonAvailable).toBe(false)
    expect(diagnostics.lines[1]).toBe(addonLine(false, '0.1.9'))
  })

  it('probes the real module graph by default', () => {
    const diagnostics = inspectInternalsBridge(['--expose-internals'])
    expect(diagnostics.internalsExposed).toBe(true)
    expect(typeof diagnostics.addonAvailable).toBe('boolean')
    expect(typeof diagnostics.addonVersion).toBe('string')
    expect(diagnostics.lines[0]).toBe(EXPOSED_LINE)
    expect(diagnostics.lines[1]).toMatch(/^addon available: (?:true|false) {2}version: \S+ {2}via: direct requireBuiltin probe$/u)
  })
})

describe('parseStartupDiagnosticLines', () => {
  it('round-trips the rendered lines', () => {
    for (const facts of [
      { internalsExposed: true, addonAvailable: false, addonVersion: '0.1.9' },
      { internalsExposed: false, addonAvailable: true, addonVersion: '0.1.9' },
      { internalsExposed: true, addonAvailable: true, addonVersion: 'unknown' },
    ]) {
      expect(parseStartupDiagnosticLines(startupDiagnosticLines(facts).join('\n'))).toEqual(facts)
    }
  })

  it('finds the lines among unrelated Host output and CRLF terminators', () => {
    const output = [
      'some plugin banner', EXPOSED_LINE, 'desktop runtime: plugin loaded', addonLine(false, '0.1.9'), '',
    ].join('\r\n')
    expect(parseStartupDiagnosticLines(output))
      .toEqual({ internalsExposed: true, addonAvailable: false, addonVersion: '0.1.9' })
  })

  it('rejects a transcript missing either line', () => {
    expect(parseStartupDiagnosticLines('')).toBeUndefined()
    expect(parseStartupDiagnosticLines(EXPOSED_LINE)).toBeUndefined()
    expect(parseStartupDiagnosticLines(addonLine(false, '0.1.9'))).toBeUndefined()
  })

  it('rejects reworded or respaced lines', () => {
    expect(parseStartupDiagnosticLines([FLAGLESS_LINE, 'addon available: false version: 0.1.9  via: direct requireBuiltin probe'].join('\n'))).toBeUndefined()
    expect(parseStartupDiagnosticLines([FLAGLESS_LINE, 'addon available: false  version: 0.1.9  via: addon probe'].join('\n'))).toBeUndefined()
    expect(parseStartupDiagnosticLines([FLAGLESS_LINE, 'addon available: no  version: 0.1.9  via: direct requireBuiltin probe'].join('\n'))).toBeUndefined()
    expect(parseStartupDiagnosticLines(['internals exposed: false  reason: R-16 addon bridge; expires 2027-01-24', addonLine(true, '0.1.9')].join('\n'))).toBeUndefined()
    expect(parseStartupDiagnosticLines(['internals exposed: true', addonLine(true, '0.1.9')].join('\n'))).toBeUndefined()
  })

  it('rejects a repeated line, which would make the answer ambiguous', () => {
    expect(parseStartupDiagnosticLines([EXPOSED_LINE, EXPOSED_LINE, addonLine(false, '0.1.9')].join('\n'))).toBeUndefined()
    expect(parseStartupDiagnosticLines([EXPOSED_LINE, addonLine(false, '0.1.9'), addonLine(true, '0.1.9')].join('\n'))).toBeUndefined()
  })
})
