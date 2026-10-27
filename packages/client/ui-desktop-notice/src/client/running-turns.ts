/**
 * Deciding when a finished turn deserves a native notification.
 *
 * The decision is pure so it can be tested without a browser or a desktop: the
 * plugin feeds it successive host states, and it reports the sessions that just
 * finished a long turn.
 * @module @deepseek-ai/dsh-client-ui-desktop-notice/client/running-turns
 */

/** What one authoritative state machine sees for one session. */
export interface TurnState {
  /** Host running state for this session. */
  readonly running: boolean
  /** Display title, used as the notification subject. */
  readonly title: string
}

/** One finished turn the plugin should announce. */
export interface FinishedTurn {
  readonly sessionId: string
  readonly title: string
  /** How long the turn ran, in milliseconds. */
  readonly elapsedMs: number
}

/** Tracks when each session started running and reports long turns that ended. */
export class RunningTurns {
  private readonly running = new Map<string, { since: number; title: string }>()

  /**
   * @param minimumMs - shortest turn worth a notification: shorter work is not
   * something a person walks away from, and notifying it would train the user
   * to ignore the notifications.
   */
  constructor(private readonly minimumMs: number) {}

  /**
   * Fold one authoritative state and return the long turns that ended.
   *
   * A session first observed already running records its start at that
   * observation, so a plugin attached mid-turn cannot announce a turn it never
   * saw begin.
   * @param now - wall-clock milliseconds for this observation.
   * @param states - every session the host currently lists, by id.
   * @returns finished turns that ran at least `minimumMs`, in map order.
   */
  fold(now: number, states: ReadonlyMap<string, TurnState>): FinishedTurn[] {
    const finished: FinishedTurn[] = []
    for (const [sessionId, state] of states) {
      const started = this.running.get(sessionId)
      if (state.running) {
        if (started === undefined) this.running.set(sessionId, { since: now, title: state.title })
        else if (started.title !== state.title) started.title = state.title
        continue
      }
      if (started === undefined) continue
      this.running.delete(sessionId)
      const elapsedMs = now - started.since
      if (elapsedMs < this.minimumMs) continue
      finished.push({ sessionId, title: state.title === '' ? started.title : state.title, elapsedMs })
    }
    // A session that left the list while running is gone, not finished.
    for (const sessionId of [...this.running.keys()]) {
      if (!states.has(sessionId)) this.running.delete(sessionId)
    }
    return finished
  }
}
