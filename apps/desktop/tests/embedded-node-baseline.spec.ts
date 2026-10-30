import { describe, expect, it } from 'vitest'
import {
  assertEmbeddedNodeBaselineGate,
  EMBEDDED_NODE_BASELINE,
  evaluateEmbeddedNodeBaselineGate,
} from '../src/embedded-node-baseline.ts'

describe('embedded Node baseline gate', () => {
  it('accepts the baseline and anything newer', () => {
    expect(evaluateEmbeddedNodeBaselineGate({ embeddedNodeVersion: '24.22.1' })).toMatchObject({ ok: true })
    expect(evaluateEmbeddedNodeBaselineGate({ embeddedNodeVersion: 'v24.23.0' })).toMatchObject({ ok: true })
    expect(evaluateEmbeddedNodeBaselineGate({ embeddedNodeVersion: '25.0.0' })).toMatchObject({ ok: true })
  })

  it('refuses a patch below the baseline, including its prerelease', () => {
    expect(evaluateEmbeddedNodeBaselineGate({ embeddedNodeVersion: '24.22.0' })).toMatchObject({ ok: false })
    expect(evaluateEmbeddedNodeBaselineGate({ embeddedNodeVersion: '24.22.1-rc.1' })).toMatchObject({ ok: false })
    expect(evaluateEmbeddedNodeBaselineGate({ embeddedNodeVersion: '24.21.9' })).toMatchObject({ ok: false })
  })

  it('fails an unrecognised probe rather than passing it quietly', () => {
    const verdict = evaluateEmbeddedNodeBaselineGate({ embeddedNodeVersion: 'not-a-version' })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('not a version this gate can compare')
  })

  it('judges against an explicit baseline', () => {
    expect(evaluateEmbeddedNodeBaselineGate({ embeddedNodeVersion: '24.22.0', baseline: '24.22.0' })).toMatchObject({ ok: true })
    expect(evaluateEmbeddedNodeBaselineGate({ embeddedNodeVersion: '24.22.0', baseline: '24.23.0' })).toMatchObject({ ok: false })
  })

  it('throws from the packaging entry point so no artifact follows a failed gate', () => {
    expect(EMBEDDED_NODE_BASELINE).toBe('24.22.1')
    expect(() => assertEmbeddedNodeBaselineGate({ embeddedNodeVersion: '24.22.0' })).toThrow(/below the 24\.22\.1 security baseline/)
    expect(assertEmbeddedNodeBaselineGate({ embeddedNodeVersion: '24.22.1' }).ok).toBe(true)
  })
})
