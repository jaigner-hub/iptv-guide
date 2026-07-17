'use strict'
/**
 * Channel health tracking + the "Hide dead" filter.
 *
 * Gives a channel nothing but dead sources, drives the real UI to click it, and
 * checks that the exhausted failover is recorded — once. Then it proves the two
 * rules that keep the filter from hiding channels that work: a failure counts at
 * most once per session, and a success is permanent.
 *
 * Everything is asserted through the DOM and the health file, never renderer
 * internals — app.js is a module, so `state` is not reachable from here, and the
 * guide is virtualised, so "no row in the DOM" only means something once a search
 * has narrowed the list. Hence #chan-count as the corroborating signal.
 *
 * Uses its own health file under .selftest, never the real one.
 *
 *   npx electron scripts/healthtest.js
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')

const { Store, Settings } = require('../src/main/store')
const { Health } = require('../src/main/health')
const { Catalog } = require('../src/main/catalog')
const { Epg } = require('../src/main/epg')
const { Scraper } = require('../src/main/scraper')
const { createServer } = require('../src/main/server')

const results = []
const ok = (c, m) => {
  results.push(!!c)
  console.log(`${c ? '  ok  ' : '  FAIL'} ${m}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Assigned once the settings file is open. Runs on the way out however we leave,
// because a run that dies holding hideDead=true poisons the next one.
let cleanup = () => {}

app.whenReady().then(async () => {
  // A URL that accepts the request and then hangs forever — how a dead iptv-org
  // stream actually behaves (200, then no segment ever arrives).
  const dead = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
    // deliberately never write, never end
  })
  await new Promise(r => dead.listen(0, '127.0.0.1', r))
  const deadUrl = `http://127.0.0.1:${dead.address().port}/dead.m3u8`

  const dir = path.join(__dirname, '..', '.selftest')
  const healthFile = path.join(dir, 'health.json')
  fs.rmSync(healthFile, { force: true }) // start from a known-empty slate

  const store = new Store(path.join(dir, 'cache'))
  const settings = new Settings(path.join(dir, 'settings.json'), { scope: 'default', country: '', favorites: [] })
  const health = new Health(healthFile, 'session-one')

  // Establish the baseline rather than trusting the last run to have cleaned up
  // after itself: a crashed run left hideDead=true here once and every assertion
  // below inverted, which reads as a broken feature rather than a dirty file.
  const restore = {
    hideDead: false, // this test drives the chip; it must start from off
    lastChannel: settings.data.lastChannel, // clicking the victim overwrites it
    favorites: (settings.data.favorites || []).filter(f => f !== '10Bold.au')
  }
  settings.set(restore)
  cleanup = () => {
    settings.set(restore)
    fs.rmSync(healthFile, { force: true })
  }

  const catalog = new Catalog(store)
  await catalog.load()
  const epg = new Epg(store, catalog)
  await epg.loadCached()

  // Every source dead: this is a channel that has "never tuned".
  const victim = catalog.channels.find(c => c.id === '10Bold.au') || catalog.channels[0]
  const mkStream = (n, q) => ({
    sid: `${victim.id}|${n}`, url: deadUrl, quality: q,
    label: null, feed: null, userAgent: null, referrer: null
  })
  victim.streams = [mkStream('dead1', '1080p'), mkStream('dead2', '720p')]
  catalog.streamBySid = new Map()
  for (const c of catalog.channels) for (const s of c.streams) catalog.streamBySid.set(s.sid, s)

  const scraper = new Scraper({
    catalog, epg,
    sitesDir: path.join(__dirname, '..', 'vendor', 'sites'),
    workDir: path.join(dir, 'guides'),
    onStatus: () => {}
  })
  const { server } = createServer({
    catalog, epg, settings, health, scraper,
    rendererDir: path.join(__dirname, '..', 'src', 'renderer'),
    onStatus: () => {}
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))

  const win = new BrowserWindow({
    // Match the real window (main.js). At the 800x600 default the toolbar was
    // cut off and the screenshot showed a layout no user will ever have.
    width: 1400, height: 860, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  })
  const boot = async () => {
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`)
    await sleep(3000)
  }
  await boot()

  const ID = JSON.stringify(victim.id)
  // The guide is virtualised — a channel that isn't on screen has no DOM node at
  // all. Search first so the victim is definitely rendered before we look for it.
  const searchVictim = async () => {
    await win.webContents.executeJavaScript(`(() => {
      const s = document.querySelector('#search')
      s.value = ${JSON.stringify(victim.name)}
      s.dispatchEvent(new Event('input'))
      return true
    })()`)
    await sleep(900) // 200ms debounce + the /api/epg/search round-trip
  }
  const probe = () => win.webContents.executeJavaScript(`(() => ({
    row: !!document.querySelector('#chancol-inner .chan[data-id=${ID}]'),
    count: parseInt(document.querySelector('#chan-count').textContent, 10),
    on: document.querySelector('#f-dead').classList.contains('on')
  }))()`)
  const chip = async () => {
    await win.webContents.executeJavaScript(`document.querySelector('#f-dead').click(), true`)
    await sleep(400)
  }
  // The star only exists while the row is rendered — so never while it's hidden.
  const star = async () => {
    await win.webContents.executeJavaScript(
      `document.querySelector('#chancol-inner .chan[data-id=${ID}] .star').click(), true`
    )
    await sleep(400)
  }

  console.log(`\ngave "${victim.name}" (${victim.id}) two dead sources: ${deadUrl}`)

  /* ── 1. the renderer reports an exhausted failover ─────────────────────── */
  await searchVictim()
  await win.webContents.executeJavaScript(
    `document.querySelector('#chancol-inner .chan[data-id=${ID}]').click(), true`
  )

  // both sources must burn their 14s stall timeout before the chain is exhausted
  let shown = false
  for (let i = 0; i < 20; i++) {
    await sleep(2000)
    shown = await win.webContents.executeJavaScript(
      `!document.querySelector('#player-error').classList.contains('hidden')`
    )
    if (shown) break
  }
  ok(shown, 'every source failed and the error is shown')

  await sleep(500) // let the POST land
  ok(health.data[victim.id]?.fails === 1, `one failure recorded (got ${JSON.stringify(health.data[victim.id])})`)
  ok(fs.existsSync(healthFile), 'it was persisted to health.json, not just held in memory')
  ok(health.deadIds().length === 0, 'one failed session is NOT enough to be dead')

  // A second failure in the same session must not count, or one bad evening of
  // clicking around buries every channel the user touched.
  health.fail(victim.id)
  ok(health.data[victim.id].fails === 1, 'a repeat failure in the same session does not count')

  /* ── 2. a second session is what makes it dead ─────────────────────────── */
  health.session = 'session-two' // i.e. the app was restarted
  health.fail(victim.id)
  ok(health.isDead(victim.id), 'failing again in a new session marks it dead')

  /* ── 3. a success is permanent ─────────────────────────────────────────── */
  health.ok(victim.id)
  ok(!health.isDead(victim.id), 'one success clears it')
  health.session = 'session-three'
  health.fail(victim.id)
  health.session = 'session-four'
  health.fail(victim.id)
  ok(!health.isDead(victim.id), 'a channel that once played can never be marked dead again')

  /* ── 4. the filter hides it, via the real bootstrap ────────────────────── */
  health.reset()
  health.session = 'session-five'
  health.fail(victim.id)
  health.session = 'session-six'
  health.fail(victim.id)
  ok(health.deadIds().includes(victim.id), 'set up: the victim is dead again')

  await boot() // reload so /api/bootstrap delivers the dead set the way it really does
  await searchVictim()

  const before = await probe()
  ok(!before.on, 'the chip starts off (as persisted)')
  ok(before.row, 'with the chip off, the dead channel is listed')

  await chip()
  const after = await probe()
  ok(!after.row, 'with the chip on, the dead channel is hidden')
  ok(after.count === before.count - 1, `exactly one channel went away (${before.count} -> ${after.count})`)
  ok(after.on, 'the chip is lit')
  ok(settings.data.hideDead === true, 'the choice is persisted')

  // A favourite is an explicit "I want this" — it must survive the filter. The
  // star only exists while the row is rendered, so turn the chip off to favourite.
  await chip()
  ok((await probe()).row, 'turning the chip back off brings it back')
  await star()
  await chip()
  ok((await probe()).row, 'a favourited channel is never hidden, even when dead')

  /* ── 5. the chip is reachable at every window size ─────────────────────── */
  // Written because the first screenshot of this feature showed the chip sitting
  // off the right edge of the toolbar: it passed every assertion above while
  // being impossible to click. ⚙ was already off-screen below ~960px before any
  // of this, which is how a 5th control tipped it over. minWidth is 900 (main.js).
  const offscreen = w => win.webContents.executeJavaScript(`(() => {
    const sels = ['#search','#f-country','#f-category','#f-fav','#f-epg','#f-dead','#btn-now','#btn-settings']
    return sels.filter(s => {
      const b = document.querySelector(s).getBoundingClientRect()
      // The toolbar may wrap to a second row; it may never push a control past
      // the right edge, which is what makes one unclickable.
      return b.width && b.right > window.innerWidth + 0.5
    })
  })()`)
  for (const w of [1400, 900]) {
    win.setContentSize(w, 860)
    await sleep(500)
    const off = await offscreen(w)
    ok(off.length === 0, `every toolbar control is on screen at ${w}px${off.length ? ` — off: ${off.join(' ')}` : ''}`)
  }
  win.setContentSize(1400, 860)
  await sleep(500)

  // Look at them, per CLAUDE.md — assertions have missed rendering bugs twice.
  const shoot = async name => {
    const f = path.join(dir, name)
    fs.writeFileSync(f, (await win.webContents.capturePage()).toPNG())
    console.log(`screenshot: ${f}`)
  }
  console.log('')
  await shoot('health-guide.png') // the new chip, lit, in the toolbar
  await win.webContents.executeJavaScript(`document.querySelector('#btn-settings').click(), true`)
  await sleep(900)
  // The modal body scrolls and the health block is below the fold — a shot of the
  // top proves nothing about the thing this test is for.
  const health$ = await win.webContents.executeJavaScript(`(() => {
    const b = document.querySelector('#btn-reset-health')
    b.scrollIntoView({ block: 'center' })
    const r = b.getBoundingClientRect()
    return { text: document.querySelector('#health-count').textContent, onScreen: r.width > 0 && r.top > 0 && r.bottom < window.innerHeight }
  })()`)
  await sleep(400)
  ok(health$.onScreen, 'the reset button is reachable in the settings modal')
  ok(/1 channel/.test(health$.text), `the modal reports the dead count (said "${health$.text}")`)
  await shoot('health-settings.png') // the new "Channel health" block
  await win.webContents.executeJavaScript(`document.querySelector('#btn-close-modal').click(), true`)
  await sleep(300)

  cleanup()
  const good = results.every(Boolean)
  console.log(`\n${good ? 'PASS' : 'FAIL'} — ${results.filter(Boolean).length}/${results.length}`)
  server.close()
  dead.close()
  app.exit(good ? 0 : 1)
}).catch(err => {
  // Without this an exception just rejects the promise and Electron sits there
  // forever with an empty log — indistinguishable from a slow test.
  cleanup()
  console.error(`\nCRASHED: ${err?.stack || err}`)
  app.exit(1)
})
