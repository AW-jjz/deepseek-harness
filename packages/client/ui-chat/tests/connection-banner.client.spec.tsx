// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionBanner, CONNECTION_RECOVERED_MS } from '../src/client/chat/ConnectionBanner.tsx'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'

afterEach(() => { cleanup(); vi.useRealTimers() })

const copy = {
  'connection.disconnected': 'Connection lost — click to reconnect',
  'connection.connecting': 'Reconnecting',
  'connection.recovered': 'Reconnected',
  'connection.reconnect': 'Reconnect',
  'connection.restart': 'Restart connection',
} as const
const t = ((key: keyof typeof copy) => copy[key]) as never

describe('connection banner', () => {
  it('says nothing while the connection is healthy', () => {
    const { container } = render(<ConnectionBanner state={'connected' as ConnectionState} reconnect={() => {}} t={t} />)
    expect(container.querySelector('[data-connection-banner]')).toBeNull()
  })

  it('offers the retry action while the socket is down', () => {
    const reconnect = vi.fn()
    render(<ConnectionBanner state={'disconnected' as ConnectionState} reconnect={reconnect} t={t} />)
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.getByText(/click to reconnect/u)).toBeTruthy()
    screen.getByRole('button', { name: 'Reconnect' }).click()
    expect(reconnect).toHaveBeenCalledOnce()
  })

  it('shows the attempt label while reconnecting, then confirms recovery briefly', () => {
    vi.useFakeTimers()
    const { rerender, container } = render(<ConnectionBanner state={'disconnected' as ConnectionState} reconnect={() => {}} t={t} />)
    rerender(<ConnectionBanner state={'connecting' as ConnectionState} reconnect={() => {}} t={t} />)
    expect(screen.getByText(/Reconnecting/u)).toBeTruthy()
    rerender(<ConnectionBanner state={'connected' as ConnectionState} reconnect={() => {}} t={t} />)
    expect(screen.getByText(/Reconnected/u)).toBeTruthy()
    // The confirmation clears itself instead of staying in the transcript.
    act(() => { vi.advanceTimersByTime(CONNECTION_RECOVERED_MS + 50) })
    expect(container.querySelector('[data-connection-banner]')).toBeNull()
  })
})
