'use strict'
/**
 * Deterministic test for the *in-playback* stall watchdog.
 *
 * stalltest.js covers a source that is dead from the first request. This covers
 * the other, more common iptv-org failure: a source that plays fine for a few
 * seconds and then dies mid-broadcast — segments simply stop arriving, hls.js
 * emits no fatal error, the picture freezes, and nothing recovers.
 *
 * We reproduce it faithfully with real, decodable media: ffmpeg generates a
 * short H.264 asset, and a local server offers it two ways —
 *   - live.m3u8: a LIVE playlist (no #EXT-X-ENDLIST) listing only the first
 *     three segments. hls.js plays ~6s, then waits forever for a fourth segment
 *     that never comes. That is the silent mid-stream stall.
 *   - vod.m3u8: the full asset as a normal VOD, wired as the channel's second
 *     source. The watchdog must notice the freeze and fail over to it.
 *
 *   npx electron scripts/midstalltest.js
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const { execFileSync } = require('node:child_process')

const { Store, Settings } = require('../src/main/store')
const { Catalog } = require('../src/main/catalog')
const { Epg } = require('../src/main/epg')
const { Scraper } = require('../src/main/scraper')
const { createServer } = require('../src/main/server')

// ── generate (and cache) a short, decodable HLS asset ──────────────────────
function buildMedia(dir) {
  const done = path.join(dir, 'seg0.ts')
  if (fs.existsSync(done)) return
  fs.mkdirSync(dir, { recursive: true })
  // testsrc → 12s of H.264 baseline (widely decodable), 2s segments = 6 files.
  try {
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15',
      '-t', '12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'baseline',
      '-level', '3.0', '-pix_fmt', 'yuv420p', '-g', '30',
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(dir, 'seg%d.ts'),
      path.join(dir, 'vod.m3u8')
    ], { stdio: ['ignore', 'ignore', 'inherit'] })
  } catch (e) {
    console.error('\nffmpeg is required to generate the test stream and could not be run.')
    console.error(String(e.message || e))
    app.exit(2)
    throw e
  }
}

app.whenReady().then(async () => {
  const dir = path.join(__dirname, '..', '.selftest')
  const mediaDir = path.join(dir, 'stallmedia')
  buildMedia(mediaDir)

  const segs = fs.readdirSync(mediaDir).filter(f => /^seg\d+\.ts$/.test(f))
    .sort((a, b) => parseInt(a.slice(3)) - parseInt(b.slice(3)))

  // A LIVE playlist that only ever offers the first three segments and never
  // ends — the whole point. hls.js plays them out and then stalls silently.
  const live = [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:0',
    ...segs.slice(0, 3).flatMap(s => ['#EXTINF:2.0,', s])
  ].join('\n') + '\n'

  const media = http.createServer((req, res) => {
    const name = req.url.split('?')[0].replace(/^\//, '')
    if (name === 'live.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      return res.end(live)
    }
    const file = path.join(mediaDir, path.basename(name))
    if (!file.startsWith(mediaDir) || !fs.existsSync(file)) {
      res.writeHead(404); return res.end()
    }
    const ct = name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t'
    res.writeHead(200, { 'content-type': ct })
    fs.createReadStream(file).pipe(res)
  })
  await new Promise(r => media.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${media.address().port}`
  const liveUrl = `${base}/live.m3u8`
  const vodUrl = `${base}/vod.m3u8`

  const store = new Store(path.join(dir, 'cache'))
  const settings = new Settings(path.join(dir, 'settings.json'), { scope: 'default', country: '', favorites: [] })
  const catalog = new Catalog(store)
  await catalog.load()
  const epg = new Epg(store, catalog)
  await epg.loadCached()

  // First source stalls mid-stream; the working VOD sits behind it as failover.
  const victim = catalog.channels.find(c => c.id === '10Bold.au') || catalog.channels[0]
  victim.streams = [
    { sid: `${victim.id}|stall`, url: liveUrl, quality: '1080p', label: null, feed: null, userAgent: null, referrer: null },
    { sid: `${victim.id}|real`, url: vodUrl, quality: '720p', label: null, feed: null, userAgent: null, referrer: null }
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

  console.log(`\ninjected mid-stream stall as first source of "${victim.name}"`)
  console.log(`  stall (live, 3 segments then silence): ${liveUrl}`)
  console.log(`  real  (full VOD failover):             ${vodUrl}`)

  const t0 = Date.now()
  await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('#chancol-inner .chan')]
    const row = rows.find(r => r.querySelector('.nm')?.textContent === ${JSON.stringify(victim.name)})
    ;(row || rows[0]).click()
    return true
  })()`)

  // We must observe the whole arc: play → freeze → reconnect → fail over. The
  // watchdog waits STALL_RECOVER_MS twice (~12s) after the ~6s of playable
  // buffer, so poll generously and record whether we ever saw playback advance.
  let res = null
  let sawPlaying = false
  let sawReconnect = false
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 2000))
    res = await win.webContents.executeJavaScript(`(() => {
      const v = document.querySelector('#video')
      return {
        picked: document.querySelector('#stream-picker')?.value,
        currentTime: +v.currentTime.toFixed(2),
        readyState: v.readyState, size: v.videoWidth + 'x' + v.videoHeight,
        spinner: !document.querySelector('#player-spinner').classList.contains('hidden'),
        error: document.querySelector('#player-error').classList.contains('hidden') ? null
             : document.querySelector('#player-error').textContent,
        status: document.querySelector('#status').textContent
      }
    })()`)
    if (res.picked?.endsWith('|stall') && res.currentTime > 0) sawPlaying = true
    if (/reconnect/i.test(res.status)) sawReconnect = true
    console.log(`  t+${(((Date.now() - t0) / 1000)).toFixed(0)}s  ${JSON.stringify(res)}`)
    // Success = it moved on to the working source and is decoding again.
    if (res.picked?.endsWith('|real') && res.readyState > 0 && res.currentTime > 0) break
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)

  // screenshot the end state — assertions have been fooled by a good-looking DOM before
  try {
    const png = await win.webContents.capturePage()
    const shot = path.join(dir, 'midstall.png')
    fs.writeFileSync(shot, png.toPNG())
    console.log(`\n  screenshot: ${shot}`)
  } catch {}

  const ok = (c, m) => console.log(`${c ? '  ok  ' : '  FAIL'} ${m}`)
  console.log(`\n[result after ${secs}s]`)
  console.log(`      ${JSON.stringify(res)}`)
  ok(sawPlaying, 'the stalling source played first (currentTime advanced before the freeze)')
  ok(sawReconnect, 'watchdog attempted an in-place reconnect before switching source')
  ok(!res.spinner, 'spinner cleared (did not hang forever)')
  ok(res.picked?.endsWith('|real'), `failed over to the working source (picked ${res.picked})`)
  ok(res.readyState > 0 && res.currentTime > 0, `failover source is decoding: ${res.size} @ ${res.currentTime}s`)

  const good = sawPlaying && !res.spinner && res.picked?.endsWith('|real') && res.readyState > 0
  server.close()
  media.close()
  app.exit(good ? 0 : 1)
})
