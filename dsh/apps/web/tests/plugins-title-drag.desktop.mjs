/** Real desktop composition; only use a marked LitIsLand profile, never daily user data. */
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { isDraggableAt } from '../../../packages/client/web/src/window-drag/regions.ts'

const stage = process.env.LG_TEST_STAGE
assert(stage?.includes('/LitIsLand/'), 'Set LG_TEST_STAGE to the isolated profile directory')
await access(join(stage, '.dashboard-test-profile'))
const app = await _electron.launch({
  executablePath: process.env.LG_APP_EXECUTABLE ?? '/Applications/LiteraryGiant.app/Contents/MacOS/LiteraryGiant',
  args: ['--user-data-dir=' + join(stage, 'userData')],
  env: { ...process.env, DSH_HOME: join(stage, 'home') },
})
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('[data-lg-pages]').waitFor()
  await page.getByRole('button', { name: /^(Plugins|插件)$/ }).click()
  await page.waitForFunction(() => {
    const body = document.querySelector('[data-plugin-body]')
    return body && body.scrollHeight > body.clientHeight + 200
  })
  let probes = 0
  for (const width of [1280, 900]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 820), width)
    for (const fraction of [0, 0.1, 0.25, 0.5, 0.75, 1, 0]) {
      await page.locator('[data-plugin-body]').evaluate((body, fraction) => { body.scrollTop = (body.scrollHeight - body.clientHeight) * fraction }, fraction)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const { regions, points } = await page.evaluate(() => {
        const rect = element => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height } }
        const regions = [...document.querySelectorAll('*')].filter(element => element.checkVisibility()).flatMap(element => {
          const region = getComputedStyle(element).webkitAppRegion
          return region === 'drag' || region === 'no-drag' ? [{ ...rect(element), draggable: region === 'drag' }] : []
        })
        const header = document.querySelector('[data-lg-pane-header]'), h = rect(header)
        const title = rect(header.querySelector('[data-lg-page-title]')), close = rect(header.querySelector('button:last-child'))
        return { regions, points: [
          { name: 'title', x: title.x + title.width / 2, y: title.y + title.height / 2, drag: true },
          { name: 'blank header', x: h.x + h.width * 0.6, y: h.y + h.height / 2, drag: true },
          { name: 'close', x: close.x + close.width / 2, y: close.y + close.height / 2, drag: false },
          { name: 'content', x: h.x + h.width * 0.6, y: h.y + h.height + 160, drag: false },
        ] }
      })
      for (const point of points) {
        assert.equal(isDraggableAt(regions, point.x, point.y), point.drag, `${width}px / scroll ${fraction} / ${point.name}`)
        probes++
      }
    }
  }
  await page.getByRole('button', { name: /Choose how to add|选择.*添加/ }).click()
  await page.getByRole('menu').waitFor()
  await page.keyboard.press('Escape')
  await page.locator('[data-lg-pane-header] button').last().click()
  await page.locator('[data-plugin-panel]').waitFor({ state: 'detached' })
  assert.deepEqual(errors, [])
  console.log(`PASS: ${probes} drag/content points, 2 widths, add menu and close; no page errors`)
} finally {
  await app.close()
}
