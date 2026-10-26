// Verify the shipped document under the new CSP: it must render, keep its landmarks, and
// report no CSP violation on the console.
import { chromium } from 'playwright'

const endpoint = process.argv[2] ?? 'http://127.0.0.1:9226'
const browser = await chromium.connectOverCDP(endpoint)
const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('dsh-app://'))
if (page === undefined) throw new Error('no dsh-app page target')

const violations = []
const pageErrors = []
page.on('console', message => {
  const text = message.text()
  if (/Content Security Policy|Refused to/i.test(text)) violations.push(text.slice(0, 220))
  else if (message.type() === 'error') violations.push(`console.error: ${text.slice(0, 200)}`)
})
page.on('pageerror', error => { pageErrors.push(error.message) })

// Reload under the attached listeners so every violation is observed from the first byte.
await page.reload({ waitUntil: 'load' })
await page.waitForTimeout(6_000)
const facts = await page.evaluate(() => {
  const main = document.querySelector('main#dsh-main')
  const skip = document.querySelector('a[href="#dsh-main"]')
  return {
    title: document.title,
    lang: document.documentElement.lang,
    hasMain: main !== null,
    mainTabIndex: main?.getAttribute('tabindex') ?? null,
    hasAside: document.querySelector('aside') !== null,
    skipText: skip?.textContent ?? null,
    scripts: document.querySelectorAll('script').length,
    bodyChars: (document.body.textContent ?? '').replace(/\s+/g, ' ').trim().length,
  }
})
await page.screenshot({ path: 'E:/AI/gui-csp.png' })
await browser.close()
console.log(JSON.stringify({ facts, violations, pageErrors }, undefined, 2))
