#!/usr/bin/env node
/**
 * probe.mjs — headless UI regression probe for the composer invariants.
 *
 * Drives a headless Chrome against a running DSH web GUI and asserts:
 *   1. the skin is applied (body[data-dsh-claude-style])
 *   2. a session page reaches phase "active"
 *   3. the composer seat is pinned to the viewport bottom (sticky contract)
 *   4. the composer field starts at one line (24px)
 *   5. the field grows with multiline content while the seat stays pinned
 *   6. clearing restores the single-line height
 *
 * Usage:
 *   node packages/testing/probe.mjs --token <launch-token> [--url http://127.0.0.1:3080]
 *
 * The launch token comes from the GUI URL (`/?token=…`) of the running DSH
 * instance; it may also be passed via the DSH_WEB_TOKEN env var. Chrome comes
 * from packages/testing/browser.mjs and is stopped when the probe ends.
 */
import { findChrome, openBrowser } from './browser.mjs'
import { withLock } from '../../scripts/shared/verify-lock.mjs'
import { TOKEN, BASE } from './cli-args.mjs'

if (!TOKEN) {
  console.error('usage: node packages/testing/probe.mjs --token <launch-token> [--url <base>]')
  process.exit(2)
}

if (!findChrome()) {
  console.error('probe: no Chrome/Edge found; set CHROME_PATH')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const instance = await openBrowser({ width: 1440, height: 900 })
  try {
    return await probe(instance.page)
  } finally {
    await instance.close()
  }
}

/** Run the checks on a fresh page; resolves with the number that failed. */
async function probe(page) {
  let failures = 0
  const check = (label, ok, detail) => {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  (' + detail + ')' : ''))
    if (!ok) failures++
  }

  await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' })
  await sleep(12000)

  check('skin applied', await page.evaluate(() => document.body.hasAttribute('data-dsh-claude-style')))

  // Open the most recent existing session. The sidebar's "new session" row
  // opens the hero, which has no session composer, and sessions can sit under
  // collapsed projects.
  const openSession = `(() => {
    const rows = Array.from(document.querySelectorAll('[data-dsh-claude-part~="session-row"]'))
      .filter((r) => !/^(新会话|New session)$/i.test((r.textContent || '').trim()))
    if (!rows.length) return false
    const t = rows[0].closest('[role="treeitem"]') || rows[0]
    t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    t.click()
    t.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    t.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    return true
  })()`
  if (!(await page.evaluate(openSession))) {
    await page.evaluate(`(() => {
      for (const p of document.querySelectorAll('[data-dsh-claude-part~="project-row"]')) {
        if (p.getAttribute('aria-expanded') !== 'true') p.click()
      }
    })()`)
    await sleep(2000)
    if (!(await page.evaluate(openSession))) throw new Error('no existing session to open')
  }
  await sleep(7000)

  const state = () => page.evaluate(`(() => {
    const root = document.querySelector('[data-phase]')
    const seat = document.querySelector('[data-composer-seat]')
    const input = document.querySelector('[data-composer-card] [data-composer-input]')
    const rect = (el) => el ? el.getBoundingClientRect() : null
    const sr = rect(seat), ir = rect(input)
    return {
      phase: root && root.getAttribute('data-phase'),
      seatBottom: sr ? Math.round(sr.bottom) : null,
      inputH: ir ? Math.round(ir.height) : null,
      innerH: innerHeight,
    }
  })()`)

  const s0 = await state()
  check('session page active', s0.phase === 'active', 'phase=' + s0.phase)
  check('composer pinned at bottom', s0.seatBottom !== null && Math.abs(s0.seatBottom - s0.innerH) <= 2, 'seatBottom=' + s0.seatBottom + ' innerH=' + s0.innerH)
  check('single-line start (24px)', s0.inputH === 24, 'inputH=' + s0.inputH)

  // grow with multiline content
  await page.evaluate(`(() => { const i = document.querySelector('[data-composer-card] [data-composer-input]'); i.focus(); return true })()`)
  await page.keyboard.insertText('line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8')
  await sleep(1500)
  const s1 = await state()
  check('field grows with content', s1.inputH !== null && s1.inputH >= 160, 'inputH=' + s1.inputH)
  check('seat stays pinned while grown', s1.seatBottom !== null && Math.abs(s1.seatBottom - s1.innerH) <= 2, 'seatBottom=' + s1.seatBottom)

  // clear the probe draft (real key events so Lexical processes them)
  await page.evaluate(`(() => { const i = document.querySelector('[data-composer-card] [data-composer-input]'); i.focus(); return true })()`)
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Backspace')
  await sleep(800)
  const s2 = await state()
  check('clears back to one line', s2.inputH === 24, 'inputH=' + s2.inputH)

  // The model trigger and the context meter share the row's right end: the
  // trailing cluster keeps the meter's room free through the variable the
  // composer pass writes on the card's parent, and while the composer is shown
  // the two must not overlap.
  const clearance = () => page.evaluate(`(() => {
    const card = document.querySelector('[data-composer-card]')
    const trailing = card === null ? null : card.querySelector('[data-dsh-claude-part~="row"] > [data-dsh-claude-part~="trailing"]')
    const meter = document.querySelector('[data-dsh-claude-context-meter]')
    if (trailing === null || meter === null) return null
    const t = trailing.getBoundingClientRect()
    const m = meter.getBoundingClientRect()
    return {
      clear: t.right <= m.left + 1,
      trailingRight: Math.round(t.right),
      meterLeft: Math.round(m.left),
      room: card.parentElement === null ? '(unset)' : card.parentElement.style.getPropertyValue('--dsh-claude-meter-room') || '(unset)',
    }
  })()`)

  const clearanceState = await clearance()
  check('model trigger clears the meter', clearanceState !== null && clearanceState.clear === true, JSON.stringify(clearanceState))

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  return failures
}

withLock('probe', 'probe', main).then(
  (failures) => { process.exitCode = failures === 0 ? 0 : 1 },
  (e) => { console.error(e); process.exitCode = 1 },
)
