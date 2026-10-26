/** In-flow connection recovery banner: visible in the session view while the socket is down. */
import { useEffect, useRef, useState } from 'react'
import { ConnectionIndicator, type ConnectionIndicatorState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { ChatFlowSlotProps } from '../contract/slots.ts'
import css from './ChatView.module.css'

/** How long a recovered connection keeps its confirmation on screen. */
export const CONNECTION_RECOVERED_MS = 2_000

/** Copy keys this banner reads from the Chat namespace. */
export type ConnectionBannerCopyKey =
  | 'connection.connecting'
  | 'connection.disconnected'
  | 'connection.reconnect'
  | 'connection.recovered'
  | 'connection.restart'

/**
 * Render the connection state inside the session view.
 *
 * The settings rail already shows this indicator, but it is hidden whenever the rail is
 * collapsed; a long turn that stops because the socket died otherwise gives no signal in the
 * main area and no way back without leaving the conversation.
 * @param props.state - Live connection state, undefined before the first outcome.
 * @param props.reconnect - Requests an immediate reconnect attempt.
 * @param props.t - Chat namespace translator.
 * @returns The banner, or null while the connection is healthy.
 */
export function ConnectionBanner({ state, reconnect, t }: {
  readonly state: ConnectionState | undefined
  readonly reconnect: () => void
  readonly t: ChatFlowSlotProps['t']
}) {
  const [recovered, setRecovered] = useState(false)
  const previous = useRef<ConnectionState | undefined>(state)
  useEffect(() => {
    const wasDown = previous.current === 'disconnected' || previous.current === 'connecting'
    previous.current = state
    if (state !== 'connected' || !wasDown) return
    setRecovered(true)
    const timer = setTimeout(() => { setRecovered(false) }, CONNECTION_RECOVERED_MS)
    return () => { clearTimeout(timer) }
  }, [state])

  const indicator: ConnectionIndicatorState | undefined = state === 'disconnected'
    ? 'disconnected'
    : state === 'connecting' ? 'connecting' : recovered ? 'recovered' : undefined
  if (indicator === undefined) return null
  return (
    <div className={css.connectionRow} data-connection-banner="" role="status" aria-live="polite">
      <ConnectionIndicator
        state={indicator}
        disconnectedLabel={t('connection.disconnected' as ConnectionBannerCopyKey)}
        connectingLabel={t('connection.connecting' as ConnectionBannerCopyKey)}
        recoveredLabel={t('connection.recovered' as ConnectionBannerCopyKey)}
        reconnectActionLabel={t('connection.reconnect' as ConnectionBannerCopyKey)}
        restartActionLabel={t('connection.restart' as ConnectionBannerCopyKey)}
        onReconnect={reconnect}
      />
    </div>
  )
}
