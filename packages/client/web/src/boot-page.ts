/**
 * Framework-free boot page and failure report. It remains available when a
 * client plugin fails because React arrives only with the UI renderer.
 * @module @deepseek-ai/dsh-client-web/src/boot-page
 */
import { bootCopy, type BootCopy, type BootLocale } from './boot-locale.ts'
import type { LoaderEntryState } from './loader-status.ts'
import css from './boot-page.module.css'

/** Create a div with one module class and optional text. */
function div(className: string | undefined, text?: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className ?? ''
  if (text !== undefined) el.textContent = text
  return el
}

/** Kernel-owned page mounted below the application's root element. */
export class BootPage {
  private readonly root: HTMLDivElement
  private readonly card: HTMLDivElement
  private readonly wordmark: HTMLDivElement
  private readonly spinner: HTMLDivElement
  private readonly hint: HTMLDivElement
  private readonly copy: BootCopy
  private readonly states = new Map<string, LoaderEntryState>()
  private readonly active = new Set<string>()
  private total = 0
  private failure: string | undefined

  /**
   * Build and attach the boot page.
   * @param container - Application mount point.
   * @param locale - language resolved from the shell before plugins loaded.
   */
  constructor(container: HTMLElement, locale: BootLocale = 'en') {
    this.copy = bootCopy(locale)
    this.root = div(css.boot)
    this.root.dataset.dshBoot = ''
    // Loading is a polite status: the progress arc changes constantly and is
    // decorative, so only the state change is announced.
    this.root.setAttribute('role', 'status')
    this.root.setAttribute('aria-live', 'polite')
    this.root.setAttribute('aria-busy', 'true')
    this.card = div(css.card)
    this.wordmark = div(css.wordmark, 'HARNESS')
    this.spinner = div(css.spinner)
    this.spinner.dataset.dshBootSpinner = ''
    this.spinner.setAttribute('aria-hidden', 'true')
    this.hint = div(css.hint, this.copy.loading)
    this.card.append(this.wordmark, this.spinner, this.hint)
    this.root.append(this.card)
    container.append(this.root)
    this.updateProgress()
  }

  /**
   * Set the number of loader entries represented by the progress arc.
   * @param total - Complete boot roster size.
   */
  setTotal(total: number): void {
    this.total = total
    this.updateProgress()
  }

  /**
   * Project one loader entry's fiber state.
   * @param id - Loader entry name.
   * @param state - Projected fiber state.
   */
  setState(id: string, state: LoaderEntryState): void {
    this.states.set(id, state)
    if (state === 'active') this.active.add(id)
    this.updateProgress()
    this.render()
  }

  /**
   * Display the boot failure report.
   * @param message - Failure report text.
   */
  fail(message: string): void {
    this.failure = message
    this.render()
  }

  /** Detach the page before or after the UI renderer takes the mount point. */
  dispose(): void {
    this.root.remove()
  }

  /** Redraw the state-dependent content below the wordmark. */
  private render(): void {
    const failed = [...this.states].filter(([, state]) => state === 'failed').map(([id]) => id)
    if (this.failure === undefined && failed.length === 0) {
      if (this.spinner.parentElement !== this.card) {
        this.card.replaceChildren(this.wordmark, this.spinner, this.hint)
      }
      return
    }
    this.root.setAttribute('aria-busy', 'false')
    const report = div(css.failed)
    // The failure is the one thing worth interrupting for, and it must offer a
    // way out: reload is the only action the kernel can take without plugins.
    const title = div(css.failedTitle, this.copy.failedTitle)
    title.setAttribute('role', 'alert')
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = css.retry ?? ''
    retry.textContent = this.copy.retry
    retry.addEventListener('click', () => { globalThis.location.reload() })
    const details = document.createElement('details')
    details.className = css.diagnostics ?? ''
    const summary = document.createElement('summary')
    summary.textContent = this.copy.diagnostics
    details.append(summary)
    // The technical record stays selectable, so it can be copied into a report.
    for (const id of failed) details.append(div(css.failedItem, id))
    if (this.failure !== undefined) details.append(div(css.failedItem, this.failure))
    const actions = div(css.actions)
    actions.append(retry)
    report.append(title, actions, details)
    this.card.replaceChildren(this.wordmark, report)
  }

  /** Grow the rotating arc monotonically as loader entries activate. */
  private updateProgress(): void {
    const ratio = this.total === 0 ? 0 : Math.min(this.active.size / this.total, 1)
    this.spinner.style.setProperty('--dsh-boot-arc', `${String(Math.round(72 + ratio * 216))}deg`)
  }
}
