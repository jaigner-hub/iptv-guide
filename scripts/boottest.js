'use strict'
/**
 * Startup regression. Two things that used to fail silently:
 *   1. a cold start must show a window immediately, not after the download
 *   2. a failed catalog download must say so, and offer a retry that works
 *
 *   npx electron scripts/boottest.js [--offline]
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const { Store, Settings } = require('../src/main/store')
const { Catalog } = require('../src/main/catalog')
const { Epg } = require('../src/main/epg')
const { Scraper } = require('../src/main/scraper')
const { createServer } = require('../src/main/server')

const OFFLINE = process.argv.includes('--offline')

app.whenReady().then(async () => {
  const dir = path.join(__dirname, '..', '.selftest-boot')
  fs.rmSync(dir, { recursive: true, force: true }) // a genuinely fresh install

  const store = new Store(path.join(dir, 'cache'))
  const settings = new Settings(path.join(dir, 'settings.json'), { scope: 'default', favorites: [] })
  const catalog = new Catalog(store)
  const epg = new Epg(store, catalog)

  // simulate an unreachable iptv-org: no DNS, no proxy, nothing
  const realFetch = global.fetch
  const goOffline = () => {
    global.fetch = (url, opts) =>
      String(url).includes('iptv-org.github.io')
        ? Promise.reject(new Error('getaddrinfo ENOTFOUND iptv-org.github.io'))
        : realFetch(url, opts)
  }
  const goOnline = () => (global.fetch = realFetch)
  if (OFFLINE) goOffline()

  let boot = { ready: false, status: 'Starting…', error: null }
  const scraper = new Scraper({
    catalog, epg, sitesDir: path.join(__dirname, '..', 'vendor', 'sites'),
    workDir: path.join(dir, 'guides'), onStatus: () => {}
  })

  const loadCatalog = async () => {
    boot = { ready: false, loading: true, status: 'Starting…', error: null }
    try {
      await catalog.load({ onProgress: m => (boot.status = m) })
      await epg.loadCached()
      boot = { ready: true, loading: false, status: '', error: null }
    } catch (err) {
      boot = { ready: false, loading: false, status: '', error: err.message }
    }
  }

  const { server } = createServer({
    catalog, epg, settings, scraper,
    rendererDir: path.join(__dirname, '..', 'src', 'renderer'),
    onStatus: () => {},
    bootState: () => boot,
    onRetry: () => loadCatalog()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))

  const t0 = Date.now()
  const win = new BrowserWindow({
    show: false, width: 1400, height: 900,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  })
  await win.loadURL(`http://127.0.0.1:${server.address().port}/`)
  const shownAt = Date.now() - t0
  loadCatalog() // exactly as main.js does: after the window, not before

  const probe = () => win.webContents.executeJavaScript(`(() => ({
    startupVisible: !document.querySelector('#startup').classList.contains('hidden'),
    startupMsg: document.querySelector('#startup-msg').textContent,
    status: document.querySelector('#status').textContent,
    rows: document.querySelectorAll('#chancol-inner .chan').length
  }))()`)

  const ok = (c, m) => console.log(`${c ? '  ok  ' : '  FAIL'} ${m}`)
  console.log(`\n[cold start${OFFLINE ? ', network down' : ''}]`)
  ok(shownAt < 3000, `window rendered in ${shownAt}ms, without waiting on the network`)

  let r
  for (let i = 0; i < 30; i++) {
    await new Promise(r2 => setTimeout(r2, 1000))
    r = await probe()
    if (r.rows > 0 || r.startupVisible) break
  }

  if (OFFLINE) {
    ok(r.startupVisible, 'failure is shown to the user, not swallowed')
    ok(/ENOTFOUND|catalog/i.test(r.startupMsg), `message names the cause: "${r.startupMsg}"`)

    // now let the network "come back" and press Try again
    goOnline()
    await win.webContents.executeJavaScript(`document.querySelector('#startup-retry').click()`)
    for (let i = 0; i < 40; i++) {
      await new Promise(r2 => setTimeout(r2, 1000))
      r = await probe()
      if (r.rows > 0) break
    }
    ok(r.rows > 0, `Try again recovered: ${r.rows} channel rows, overlay ${r.startupVisible ? 'still up' : 'gone'}`)
  } else {
    ok(r.rows > 0, `catalog loaded into the guide: ${r.rows} rows visible`)
    ok(!r.startupVisible, 'no error overlay')
    console.log(`      status: ${r.status}`)
  }

  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
  app.exit(0)
}).catch(err => {
  // A throw inside app.whenReady().then() is an unhandled rejection: Electron
  // stays alive with an empty log, which reads exactly like a slow test. Fail loudly.
  console.error(`\nCRASHED: ${err?.stack || err}`)
  app.exit(1)
})
