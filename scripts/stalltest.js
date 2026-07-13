'use strict'
/**
 * Deterministic test for the stall watchdog.
 *
 * A dead iptv-org stream typically does NOT error — the socket opens and no
 * segment ever arrives, so hls.js waits forever. This injects exactly that: a
 * local server that returns 200 and then sends nothing, as the channel's first
 * source, with a real working stream behind it. The player must give up on the
 * dead source and fail over.
 *
 *   npx electron scripts/stalltest.js
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const http = require('node:http')

const { Store, Settings } = require('../src/main/store')
const { Catalog } = require('../src/main/catalog')
const { Epg } = require('../src/main/epg')
const { Scraper } = require('../src/main/scraper')
const { createServer } = require('../src/main/server')

app.whenReady().then(async () => {
  // a URL that accepts the request and then hangs forever
  const dead = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
    // deliberately never write, never end
  })
  await new Promise(r => dead.listen(0, '127.0.0.1', r))
  const deadUrl = `http://127.0.0.1:${dead.address().port}/dead.m3u8`

  const dir = path.join(__dirname, '..', '.selftest')
  const store = new Store(path.join(dir, 'cache'))
  const settings = new Settings(path.join(dir, 'settings.json'), { scope: 'default', country: '', favorites: [] })
  const catalog = new Catalog(store)
  await catalog.load()
  const epg = new Epg(store, catalog)
  await epg.loadCached()

  // Put the dead source FIRST on a channel we know plays, keeping the real one
  // as the fallback. This is the situation the watchdog exists for.
  const victim = catalog.channels.find(c => c.id === '10Bold.au') || catalog.channels[0]
  const real = victim.streams[0]
  victim.streams = [
    { sid: `${victim.id}|dead`, url: deadUrl, quality: '1080p', label: null, feed: null, userAgent: null, referrer: null },
    { ...real, sid: `${victim.id}|real` }
  ]
  catalog.streamBySid = new Map()
  for (const c of catalog.channels) for (const s of c.streams) catalog.streamBySid.set(s.sid, s)

  const scraper = new Scraper({
    catalog, epg,
    sitesDir: path.join(__dirname, '..', 'vendor', 'sites'),
    workDir: path.join(dir, 'guides'),
    onStatus: () => {}
  })
  const { server } = createServer({
    catalog, epg, settings, scraper,
    rendererDir: path.join(__dirname, '..', 'src', 'renderer'),
    onStatus: () => {}
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  })
  await win.loadURL(`http://127.0.0.1:${server.address().port}/`)
  await new Promise(r => setTimeout(r, 3000))

  console.log(`\ninjected dead source as first stream of "${victim.name}"`)
  console.log(`  dead: ${deadUrl}`)
  console.log(`  real: ${real.url.slice(0, 70)}`)

  const t0 = Date.now()
  await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('#chancol-inner .chan')]
    const row = rows.find(r => r.querySelector('.nm')?.textContent === ${JSON.stringify(victim.name)})
    ;(row || rows[0]).click()
    return true
  })()`)

  // poll until it either plays or shows an error — never longer than the watchdog + slack
  let res = null
  for (let i = 0; i < 14; i++) {
    await new Promise(r => setTimeout(r, 2000))
    res = await win.webContents.executeJavaScript(`(() => {
      const v = document.querySelector('#video')
      return {
        picked: document.querySelector('#stream-picker')?.value,
        readyState: v.readyState, size: v.videoWidth + 'x' + v.videoHeight,
        spinner: !document.querySelector('#player-spinner').classList.contains('hidden'),
        error: document.querySelector('#player-error').classList.contains('hidden') ? null
             : document.querySelector('#player-error').textContent,
        status: document.querySelector('#status').textContent
      }
    })()`)
    if (res.readyState > 0 || res.error) break
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)

  const ok = (c, m) => console.log(`${c ? '  ok  ' : '  FAIL'} ${m}`)
  console.log(`\n[result after ${secs}s]`)
  console.log(`      ${JSON.stringify(res)}`)
  ok(!res.spinner, 'spinner cleared (did not hang forever)')
  ok(res.picked?.endsWith('|real'), `failed over to the working source (picked ${res.picked})`)
  ok(res.readyState > 0, `video is decoding: ${res.size}`)

  const good = !res.spinner && res.readyState > 0
  server.close()
  dead.close()
  app.exit(good ? 0 : 1)
})
