/** `dsh-ops panel`: one loopback command that serves the viewer and one capture directory. */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { JSDOM } from 'jsdom'
import { createPanelServer, defaultPanelDirectory, inspectPanelDirectory, listenPanel } from '../lib/cli/panel.js'
import { PANEL_FORMAT } from '../lib/panel/collect.js'
import { renderPanelHtml } from '../lib/panel/render.js'
import { PACKAGE_ROOT, assert, report, test, withTempDir } from './lib/harness.mjs'

const CLI = path.join(PACKAGE_ROOT, 'bin', 'dsh-ops.mjs')

/** One minimal valid panel document. */
function document(sessionId, cwd) {
  return {
    schemaVersion: 1,
    format: PANEL_FORMAT,
    meta: { sessionId, cwd },
    metrics: {},
    conversation: [],
    trace: [],
    verify: {},
    events: {},
    archive: [],
    limits: {},
  }
}

/** Write one report and pin its modification time so "newest" is deterministic. */
function seed(dir, file, sessionId, seconds) {
  const target = path.join(dir, file)
  fs.writeFileSync(target, JSON.stringify(document(sessionId, dir)))
  fs.utimesSync(target, seconds, seconds)
  return target
}

/** Run one body against a real loopback server, and always close it. */
async function withServer(dir, body) {
  const server = createPanelServer({ dir })
  const port = await listenPanel(server, { port: 0 })
  try {
    return await body({ base: `http://127.0.0.1:${port}`, port, server })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

/** Start the real CLI and resolve its printed loopback URL. */
function startCli(dir) {
  const child = spawn(process.execPath, [CLI, 'panel', dir, '--port', '0'], {
    cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the CLI did not print a URL: ${stdout}${stderr}`)), 20_000)
    const check = () => {
      const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)\//u)
      if (match) { clearTimeout(timer); resolve(match[0]) }
    }
    child.stdout.on('data', check)
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`the CLI exited early (${code}): ${stdout}${stderr}`)) })
    check()
  })
  return { child, url, get stdout() { return stdout }, get stderr() { return stderr } }
}

/** Kill the CLI and wait until it is gone, without leaving a listener behind. */
async function stopCli(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 5_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill('SIGTERM')
  })
}

await test('the capture directory is inspected in place: newest valid report, malformed files named', async () => {
  await withTempDir('panel-serve-inspect', async root => {
    const missing = path.join(root, 'absent')
    assert.throws(() => inspectPanelDirectory(missing), /No panel capture directory/u)
    const dir = path.join(root, 'capture')
    fs.mkdirSync(dir)
    assert.deepEqual(inspectPanelDirectory(dir), { dir, sessions: [], invalid: [] })
    seed(dir, 'old.json', 'old', 1_000)
    seed(dir, 'new.json', 'new', 2_000)
    fs.writeFileSync(path.join(dir, 'broken.json'), '{"format":')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored')
    fs.writeFileSync(path.join(dir, 'panel.html'), '<html></html>')
    const index = inspectPanelDirectory(dir)
    assert.deepEqual(index.sessions.map(session => session.file), ['new.json', 'old.json'])
    assert.equal(index.latest.file, 'new.json')
    assert.deepEqual(index.invalid.map(entry => entry.file), ['broken.json'])
    assert.match(index.invalid[0].reason, /JSON|not a dsh-ops\/panel-capture@1/u)
    assert.equal(defaultPanelDirectory(root), path.join(root, '.dsh-ops', 'panel'))
  })
})

await test('the served root preselects the newest valid report and serves the packaged viewer', async () => {
  await withTempDir('panel-serve-root', async root => {
    const dir = path.join(root, 'capture')
    fs.mkdirSync(dir)
    seed(dir, 'old.json', 'old', 1_000)
    seed(dir, 'new.json', 'new', 2_000)
    fs.writeFileSync(path.join(dir, 'broken.json'), 'nope')
    await withServer(dir, async ({ base }) => {
      const rootResponse = await fetch(`${base}/`, { redirect: 'manual' })
      assert.equal(rootResponse.status, 302)
      assert.equal(rootResponse.headers.get('location'), '/panel.html?data=new.json')
      const viewer = await fetch(`${base}/panel.html`)
      assert.equal(viewer.status, 200)
      assert.match(viewer.headers.get('content-type'), /text\/html/u)
      const html = await viewer.text()
      assert.match(html, /id="sessions"/u)
      assert.match(html, /\/api\/sessions/u, 'the viewer must ask the server for its session list')
      assert.equal(html.includes('"schemaVersion"'), false, 'the viewer never inlines report data')
    })
  })
})

await test('the session index and one report are served; malformed reports are refused with a reason', async () => {
  await withTempDir('panel-serve-data', async root => {
    const dir = path.join(root, 'capture')
    fs.mkdirSync(dir)
    seed(dir, 'old.json', 'old', 1_000)
    seed(dir, 'new.json', 'new', 2_000)
    fs.writeFileSync(path.join(dir, 'broken.json'), '{"format":')
    await withServer(dir, async ({ base }) => {
      const indexResponse = await fetch(`${base}/api/sessions`)
      assert.equal(indexResponse.status, 200)
      assert.match(indexResponse.headers.get('content-type'), /application\/json/u)
      const index = await indexResponse.json()
      assert.deepEqual(index.sessions.map(session => session.file), ['new.json', 'old.json'])
      assert.equal(index.latest, 'new.json')
      assert.deepEqual(index.invalid.map(entry => entry.file), ['broken.json'])
      const report = await fetch(`${base}/old.json`)
      assert.equal(report.status, 200)
      assert.equal(JSON.parse(await report.text()).meta.sessionId, 'old')
      const broken = await fetch(`${base}/broken.json`)
      assert.equal(broken.status, 422)
      assert.match(await broken.text(), /not a valid panel report/u)
    })
  })
})

await test('path traversal, symlink escapes, write methods and unknown files are refused', async () => {
  await withTempDir('panel-serve-refuse', async root => {
    const dir = path.join(root, 'capture')
    fs.mkdirSync(dir)
    seed(dir, 'session.json', 'session', 1_000)
    fs.writeFileSync(path.join(root, 'outside.json'), JSON.stringify(document('outside', root)))
    if (process.platform !== 'win32') fs.symlinkSync(path.join(root, 'outside.json'), path.join(dir, 'escape.json'))
    await withServer(dir, async ({ base }) => {
      const encoded = await fetch(`${base}/%2e%2e%2foutside.json`)
      assert.equal(encoded.status, 403)
      assert.match(await encoded.text(), /outside the served directory/u)
      const backslash = await fetch(`${base}/..%5coutside.json`)
      assert.equal(backslash.status, 403)
      const plain = await fetch(`${base}/../outside.json`)
      assert.equal(plain.status, 404, 'a normalized path cannot read the parent directory')
      assert.equal((await plain.text()).includes('"outside"'), false)
      if (process.platform !== 'win32') {
        const escape = await fetch(`${base}/escape.json`)
        assert.equal(escape.status, 404, 'a symlink out of the capture directory is not served')
      }
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const response = await fetch(`${base}/`, { method })
        assert.equal(response.status, 405)
        assert.equal(response.headers.get('allow'), 'GET, HEAD')
      }
      assert.equal((await fetch(`${base}/nope.json`)).status, 404)
      assert.equal((await fetch(`${base}/panel.html/`)).status, 404)
      const head = await fetch(`${base}/session.json`, { method: 'HEAD' })
      assert.equal(head.status, 200)
      assert.equal(await head.text(), '')
    })
  })
})

await test('an empty or malformed-only directory still serves the picker instead of failing', async () => {
  await withTempDir('panel-serve-empty', async root => {
    const empty = path.join(root, 'empty')
    fs.mkdirSync(empty)
    await withServer(empty, async ({ base }) => {
      const rootResponse = await fetch(`${base}/`, { redirect: 'manual' })
      assert.equal(rootResponse.status, 302)
      assert.equal(rootResponse.headers.get('location'), '/panel.html')
      assert.equal((await fetch(`${base}/panel.html`)).status, 200)
      const index = await (await fetch(`${base}/api/sessions`)).json()
      assert.deepEqual(index.sessions, [])
      assert.equal(index.latest, null)
    })
    const broken = path.join(root, 'broken')
    fs.mkdirSync(broken)
    fs.writeFileSync(path.join(broken, 'only.json'), 'not json')
    await withServer(broken, async ({ base }) => {
      assert.equal((await fetch(`${base}/`, { redirect: 'manual' })).status, 302)
      const index = await (await fetch(`${base}/api/sessions`)).json()
      assert.deepEqual(index.invalid.map(entry => entry.file), ['only.json'])
    })
  })
})

/** Poll a synchronous condition without depending on a fixed scheduler delay. */
async function until(condition, timeout = 3_000) {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for the viewer to update')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

await test('the served viewer lists sessions from the index and switches without a reload', async () => {
  const sessions = [
    { file: 'new.json', sessionId: 'new', mtimeMs: 2_000, bytes: 1 },
    { file: 'old.json', sessionId: 'old', mtimeMs: 1_000, bytes: 1 },
  ]
  const reports = {
    'new.json': JSON.stringify({ ...document('new', '/work'), conversation: [{ seq: 0, role: 'user', text: 'from new' }] }),
    'old.json': JSON.stringify({ ...document('old', '/work'), conversation: [{ seq: 0, role: 'user', text: 'from old' }] }),
  }
  const requested = []
  const dom = new JSDOM(renderPanelHtml(), {
    runScripts: 'dangerously',
    url: 'http://127.0.0.1:4321/panel.html?data=new.json',
    beforeParse(window) {
      window.fetch = input => {
        const target = String(input)
        requested.push(target)
        if (target === '/api/sessions') {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sessions, latest: 'new.json', invalid: [] }) })
        }
        const body = reports[target]
        return Promise.resolve(body === undefined
          ? { ok: false, status: 404, text: () => Promise.resolve('') }
          : { ok: true, status: 200, text: () => Promise.resolve(body) })
      }
    },
  })
  try {
    const { document: page } = dom.window
    await until(() => page.getElementById('sessions').options.length === 2)
    const select = page.getElementById('sessions')
    assert.equal(page.getElementById('sessions-row').hidden, false)
    assert.deepEqual([...select.options].map(option => option.value), ['new.json', 'old.json'])
    assert.equal(select.value, 'new.json')
    await until(() => page.getElementById('source').textContent.includes('new.json'))
    assert.match(page.getElementById('tab-conversation').textContent, /from new/u)
    select.value = 'old.json'
    select.dispatchEvent(new dom.window.Event('change'))
    await until(() => page.getElementById('source').textContent.includes('old.json'))
    assert.match(page.getElementById('tab-conversation').textContent, /from old/u)
    assert.equal(new URL(dom.window.location.href).searchParams.get('data'), 'old.json')
    assert.ok(!requested.includes('panel.html'), 'a switch fetches the report, not a new page')
  } finally {
    dom.window.close()
  }
})

await test('the real CLI prints a loopback URL, serves the newest report and rejects an invalid port', async () => {
  await withTempDir('panel-serve-cli', async root => {
    const dir = path.join(root, 'capture')
    fs.mkdirSync(dir)
    seed(dir, 'old.json', 'old', 1_000)
    seed(dir, 'new.json', 'new', 2_000)
    const run = startCli(dir)
    try {
      const url = await run.url
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/u)
      const rootResponse = await fetch(url, { redirect: 'manual' })
      assert.equal(rootResponse.status, 302)
      assert.equal(rootResponse.headers.get('location'), '/panel.html?data=new.json')
      const index = await (await fetch(`${url}api/sessions`)).json()
      assert.equal(index.latest, 'new.json')
      await Promise.resolve()
      assert.match(run.stdout, /Default session: new\.json/u)
      assert.match(run.stdout, /Loopback only/u)
    } finally {
      await stopCli(run.child)
    }
    const bad = spawnSync(process.execPath, [CLI, 'panel', dir, '--port', '99999'], { encoding: 'utf8', timeout: 30_000 })
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /--port must be an integer from 0 to 65535/u)
    const stray = spawnSync(process.execPath, [CLI, 'install', '--profile', 'web', '--serve'], { encoding: 'utf8', timeout: 30_000 })
    assert.equal(stray.status, 1)
    assert.match(stray.stderr, /--serve only applies to the panel command/u)
  })
})

report('panel-serve')
