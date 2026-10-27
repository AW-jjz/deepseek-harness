// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BootPage } from '../src/boot-page.ts'
import { applyBootLocale, bootCopy, resolveBootLocale } from '../src/boot-locale.ts'

afterEach(() => { document.body.innerHTML = '' })

function mount(locale?: 'zh') {
  const el = document.createElement('div')
  document.body.append(el)
  return { el, page: new BootPage(el, ...(locale === undefined ? [] : [locale] as const)) }
}

describe('BootPage', () => {
  it('draws the loading skeleton before any plugin state arrives', () => {
    const { el } = mount()
    expect(el.firstElementChild?.getAttribute('data-dsh-boot')).toBe('')
    expect(el.textContent).toContain('HARNESS')
    expect(el.textContent).toContain('Loading plugins…')
  })

  it('keeps loading while entries are active or loading', () => {
    const { el, page } = mount()
    page.setTotal(2)
    const spinner = el.querySelector<HTMLElement>('[data-dsh-boot-spinner]')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('72deg')
    page.setState('a', 'active')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('180deg')
    page.setState('b', 'loading')
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBe(spinner)
    page.setState('b', 'active')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('288deg')
    expect(el.textContent).toContain('Loading plugins…')
    expect(el.textContent).not.toContain('Failed to load plugins')
  })

  it('lists failed entries', () => {
    const { el, page } = mount()
    page.setState('@deepseek-ai/dsh-client-ui-layout', 'failed')
    page.setState('ok', 'active')
    page.setState('@deepseek-ai/dsh-client-ui-tool', 'failed')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-layout')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-tool')
    expect(el.textContent).not.toContain('ok')
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('shows the complete sweep report', () => {
    const { el, page } = mount()
    const report = 'web boot: 1 entry did not activate\nx: pending (waiting for service: y)'
    page.fail(report)
    page.setState('a', 'active')
    expect(el.textContent).toContain(report)
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('names the failure, offers a retry, and keeps the technical report copyable', () => {
    const { el, page } = mount()
    page.setState('@deepseek-ai/dsh-client-ui-layout', 'failed')
    expect(el.textContent).toContain('Plugins failed to load')
    expect(el.querySelector('button')?.textContent).toBe('Try again')
    expect(el.querySelector('details summary')?.textContent).toBe('Details')
    expect(el.querySelector('details')?.textContent).toContain('@deepseek-ai/dsh-client-ui-layout')
  })

  it('announces loading as a polite status and stops being busy on failure', () => {
    const { el, page } = mount()
    const root = el.firstElementChild as HTMLElement
    expect(root.getAttribute('role')).toBe('status')
    expect(root.getAttribute('aria-live')).toBe('polite')
    expect(root.getAttribute('aria-busy')).toBe('true')
    expect(root.querySelector('[data-dsh-boot-spinner]')?.getAttribute('aria-hidden')).toBe('true')
    page.setState('broken', 'failed')
    expect(root.getAttribute('aria-busy')).toBe('false')
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('Plugins failed to load')
  })

  it('reloads the page from the failure retry', () => {
    const { el, page } = mount()
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    try {
      page.fail('boom')
      ;(el.querySelector('button') as HTMLButtonElement).click()
      expect(reload).toHaveBeenCalledOnce()
    } finally { vi.unstubAllGlobals() }
  })

  it('draws its own copy in the resolved language', () => {
    const { el } = mount('zh')
    expect(el.textContent).toContain('正在加载插件…')
  })

  it('detaches on disposal', () => {
    const { el, page } = mount()
    page.dispose()
    expect(el.childNodes).toHaveLength(0)
  })
})

describe('boot locale', () => {
  it('resolves the first shipped language among the preferred tags', () => {
    expect(resolveBootLocale(['zh-CN', 'en-US'])).toBe('zh')
    expect(resolveBootLocale(['en-GB', 'zh-CN'])).toBe('en')
    expect(resolveBootLocale(['ja-JP'])).toBe('ja')
    expect(resolveBootLocale(['pt-BR'])).toBe('pt')
    expect(resolveBootLocale(['ko-KR'])).toBe('en')
    expect(resolveBootLocale([])).toBe('en')
  })

  it('states a regional tag for Chinese so screen readers pick a Chinese voice', () => {
    document.documentElement.lang = 'en'
    expect(applyBootLocale(document, ['zh-Hans'])).toBe('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(applyBootLocale(document, ['de'])).toBe('de')
    expect(document.documentElement.lang).toBe('de')
  })

  it('keeps every language copy complete', () => {
    for (const locale of ['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt'] as const) {
      const copy = bootCopy(locale)
      for (const text of Object.values(copy)) expect(text.length).toBeGreaterThan(0)
    }
  })
})
