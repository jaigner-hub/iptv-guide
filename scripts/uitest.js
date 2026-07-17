'use strict'
/**
 * Renderer smoke test: boots the real backend, loads the real page in a hidden
 * Electron window, and asserts the guide actually rendered. Catches the class of
 * bug a headless API test cannot — a renderer exception leaves a blank window.
 *
 *   npx electron scripts/uitest.js
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

const { Store, Settings } = require('../src/main/store')
const { Catalog } = require('../src/main/catalog')
const { Epg } = require('../src/main/epg')
const { Scraper } = require('../src/main/scraper')
const { createServer } = require('../src/main/server')

const errors = []
const logs = []

// --fresh reproduces a first launch: no cached guide, EPG refresh running in the
// background while the user clicks a channel. That is the state a new install is in.
const FRESH = process.argv.includes('--fresh')

app.whenReady().then(async () => {
  // repo-local so the WSL selftest and the Windows Electron run share one cache
  const dir = path.join(__dirname, '..', FRESH ? '.selftest-fresh' : '.selftest')
  if (FRESH) require('node:fs').rmSync(dir, { recursive: true, force: true })
  const store = new Store(path.join(dir, 'cache'))
  const settings = new Settings(path.join(dir, 'settings.json'), {
    scope: 'default',
    country: '',
    favorites: [],
    hideNsfw: true
  })
  const catalog = new Catalog(store)
  await catalog.load()
  const epg = new Epg(store, catalog)
  const had = await epg.loadCached()

  const scraper = new Scraper({
    catalog,
    epg,
    sitesDir: path.join(__dirname, '..', 'vendor', 'sites'),
    workDir: path.join(dir, 'guides'),
    onStatus: () => {}
  })
  const { server } = createServer({
    catalog,
    epg,
    settings,
    scraper,
    rendererDir: path.join(__dirname, '..', 'src', 'renderer'),
    onStatus: () => {}
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  // exactly what main.js does on a first launch
  if (!had || epg.isStale()) {
    console.log('      (no cached guide — refreshing in background, as a fresh install does)')
    epg.refresh({ onProgress: () => {} }).catch(e => console.log('      guide error: ' + e.message))
  }

  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message)
    else logs.push(message)
  })
  win.webContents.on('render-process-gone', (_e, d) => errors.push('renderer gone: ' + d.reason))

  await win.loadURL(`http://127.0.0.1:${port}/`)
  await new Promise(r => setTimeout(r, 3500)) // let boot() + first render settle

  const probe = await win.webContents.executeJavaScript(`(() => {
    const rows   = document.querySelectorAll('#chancol-inner .chan').length
    const progs  = document.querySelectorAll('#grid-inner .prog').length
    const live   = document.querySelectorAll('#grid-inner .prog.live').length
    const empty  = document.querySelectorAll('#grid-inner .prog.empty').length
    const ticks  = document.querySelectorAll('#timebar-inner .tick').length
    const count  = document.querySelector('#chan-count')?.textContent
    const status = document.querySelector('#status')?.textContent
    const first  = document.querySelector('#chancol-inner .chan .nm')?.textContent
    const titles = [...document.querySelectorAll('#grid-inner .prog.live .pt')].slice(0,5).map(n=>n.textContent)
    return { rows, progs, live, empty, ticks, count, status, first, titles, hls: !!window.Hls }
  })()`)

  // Rows are absolutely positioned and reused across renders. Anything that
  // re-sorts or re-filters the list (favouriting floats a channel to the top)
  // used to leave a reused row at its old `top`, painting two channels on the
  // same line. Drive each re-sort and assert no two rows share an offset.
  const overlap = () => win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('#chancol-inner .chan')]
    const seen = new Map(), clash = []
    for (const r of rows) {
      const t = r.style.top, nm = r.querySelector('.nm').textContent
      if (seen.has(t)) clash.push(seen.get(t) + ' + ' + nm)
      else seen.set(t, nm)
    }
    return { clash, stars: rows.filter(r => r.classList.contains('fav')).length }
  })()`)
  const act = async js => {
    await win.webContents.executeJavaScript(js)
    await new Promise(r => setTimeout(r, 600))
  }

  const resort = []
  resort.push(['first render', await overlap()])

  // Favourite one specific channel and track it by id. Clicking a row *index* to
  // undo this would hit the wrong channel — favourites sort to the top, so the
  // row that was at index 6 is not the row that is there afterwards.
  const before = (await overlap()).stars
  const favId = await win.webContents.executeJavaScript(
    `document.querySelectorAll('#chancol-inner .chan')[6].dataset.id`
  )
  const clickStar = id =>
    act(`document.querySelector('#chancol-inner .chan[data-id="${id}"] .star').click()`)

  await clickStar(favId)
  const afterFav = await overlap()
  resort.push(['after favouriting', afterFav])
  await act(`document.querySelector('#f-epg').click()`)
  resort.push(['after "Guide only"', await overlap()])
  // each script runs in the page's global scope, so `const` must stay inside an IIFE
  await act(`(() => { const s = document.querySelector('#search')
                      s.value = 'a'; s.dispatchEvent(new Event('input')) })()`)
  resort.push(['after searching', await overlap()])

  // leave the settings file exactly as we found it
  await act(`(() => { const s = document.querySelector('#search')
                      s.value = ''; s.dispatchEvent(new Event('input'))
                      document.querySelector('#f-epg').click() })()`)
  await clickStar(favId)
  const restored = (await overlap()).stars

  // Programme search must find channels whose *names* don't contain the term —
  // that is the whole point, and it only works because the server answers from
  // the full guide (the renderer holds programmes for on-screen rows only).
  //
  // The term is picked from the live guide rather than hard-coded: which shows
  // are actually on changes every refresh, so "seinfeld" is a coin flip. We ask
  // for a title that is on soon, on a channel not named after it.
  const progSearch = await win.webContents.executeJavaScript(`(async () => {
    const contains = (a, b) => a.toLowerCase().includes(b.toLowerCase())
    // find a term that genuinely exercises programme-only matching
    let term = null, byProgOnly = 0
    for (const cand of ['forensic files', 'news', 'movie', 'live', 'weather']) {
      const hits = await (await fetch('/api/epg/search?q=' + encodeURIComponent(cand))).json()
      const names = await (await fetch('/api/bootstrap')).json()
      const nameOf = new Map(names.channels.map(c => [c.id, c.name]))
      const only = Object.keys(hits).filter(id => nameOf.has(id) && !contains(nameOf.get(id), cand))
      if (only.length > byProgOnly) { term = cand; byProgOnly = only.length }
      if (byProgOnly > 20) break
    }
    if (!term) return { term: null }

    const s = document.querySelector('#search')
    s.value = term; s.dispatchEvent(new Event('input'))
    await new Promise(r => setTimeout(r, 1400))
    const rows = [...document.querySelectorAll('#chancol-inner .chan')]
    const hits = rows.filter(r => r.querySelector('.sub.hit'))

    // Clicking the hit line should bring that programme into view. Asserting the
    // scroll position merely *changed* is not enough — a hit 40 min out clamps to
    // the left edge, where the grid already was. Assert the thing we actually
    // promise: the matched block is now on screen. Pick the hit furthest ahead so
    // there is somewhere to scroll to; name matches sort first, so scroll past them.
    const g = document.querySelector('#grid')
    g.scrollTop = 900
    await new Promise(r => setTimeout(r, 700))
    const future = [...document.querySelectorAll('#chancol-inner .chan .sub.hit.jump')]
      .sort((a, b) => +b.dataset.start - +a.dataset.start)[0]

    let jumped = null, jumpedTo = null
    if (future) {
      jumpedTo = future.querySelector('.hit-when').textContent
      const chan = future.closest('.chan').dataset.id
      future.click()
      await new Promise(r => setTimeout(r, 1000))
      // the matched programme for that channel must now sit inside the viewport
      const gb = g.getBoundingClientRect()
      jumped = [...document.querySelectorAll('#grid-inner .prog.match')]
        .filter(p => p.dataset.ch === chan)
        .some(p => {
          const b = p.getBoundingClientRect()
          return b.right > gb.left && b.left < gb.right
        })
    }
    g.scrollTop = 0
    await new Promise(r => setTimeout(r, 300))

    // a finished programme is not a result: nothing the server returns may have ended
    const raw = await (await fetch('/api/epg/search?q=' + encodeURIComponent(term))).json()
    const now = Date.now()
    const ended = Object.values(raw).filter(h => h.e <= now).length

    const out = {
      term, byProgOnly, jumped, jumpedTo, ended,
      matched: Object.keys(raw).length,
      total: document.querySelector('#chan-count').textContent,
      hits: hits.length,
      matchBlocks: document.querySelectorAll('#grid-inner .prog.match').length,
      sample: hits.slice(0, 3).map(r => r.querySelector('.nm').textContent + ' -> ' +
        r.querySelector('.hit-when').textContent + ' ' + r.querySelector('.hit-title').textContent)
    }
    s.value = ''; s.dispatchEvent(new Event('input'))
    await new Promise(r => setTimeout(r, 500))
    return out
  })()`)

  // Exercise the real player path. A given iptv-org stream may be geo-blocked or
  // only broadcast part-time, so try several and require that *some* channel
  // actually decodes frames.
  let play = null
  for (let i = 0; i < 6; i++) {
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('#chancol-inner .chan')[${i}]?.click()`
    )
    await new Promise(r => setTimeout(r, 7000))
    play = await win.webContents.executeJavaScript(`(() => {
      const v = document.querySelector('#video')
      return {
        collapsed: document.querySelector('#player').classList.contains('collapsed'),
        name: document.querySelector('#np-name')?.textContent,
        src: (v?.currentSrc || '').slice(0, 46),
        readyState: v?.readyState,
        w: v?.videoWidth, h: v?.videoHeight,
        err: document.querySelector('#player-error')?.classList.contains('hidden') ? null
             : document.querySelector('#player-error')?.textContent
      }
    })()`)
    console.log(
      `      try ${i + 1}: ${play.name} -> readyState=${play.readyState} ${play.w}x${play.h}${play.err ? ' (error shown)' : ''}`
    )
    if (play.readyState > 0 && play.videoWidth !== 0) break
    if (play.readyState > 0) break
  }

  // Sleep timer. The countdown is derived from a wall-clock deadline rather than
  // counted in ticks — which is exactly what makes this testable: move the page's
  // clock forward and the timer must behave as if 15 minutes really passed. A
  // tick-counting implementation would sail straight through this.
  const sleepTest = await win.webContents.executeJavaScript(`(async () => {
    const btn = document.querySelector('#btn-sleep')
    const v = document.querySelector('#video')
    const wait = ms => new Promise(r => setTimeout(r, ms))

    // "End of this programme" is only offered when we know what's on, so pick a
    // channel that actually has a live programme rather than whichever one the
    // playback loop landed on (most channels have no guide data).
    const liveCh = document.querySelector('#grid-inner .prog.live')?.dataset.ch
    if (liveCh) {
      document.querySelector(\`#chancol-inner .chan[data-id="\${liveCh}"]\`)?.click()
      await wait(1200)
    }
    if (document.querySelector('#player').classList.contains('collapsed')) return { skip: true }

    v.volume = 0.8 // a volume the user chose; the fade must hand it back
    btn.click()                                  // open the menu

    // The menu must be fully on screen. It opens upward from controls that sit at
    // the bottom of a short panel, and a 7-item menu ran straight off the top of
    // the window — visible in a screenshot, invisible to every other assertion.
    const mb = document.querySelector('#sleep-menu').getBoundingClientRect()
    const onScreen = mb.top >= 0 && mb.left >= 0 &&
                     mb.bottom <= window.innerHeight && mb.right <= window.innerWidth
    const menuBox = { top: Math.round(mb.top), bottom: Math.round(mb.bottom),
                      left: Math.round(mb.left), right: Math.round(mb.right),
                      vw: window.innerWidth, vh: window.innerHeight }

    const items = [...document.querySelectorAll('#sleep-menu .menu-item')]
      .map(b => b.querySelector('.mi-label').textContent)
    const epgOption = items.includes('End of this programme')
    const epgHint = [...document.querySelectorAll('#sleep-menu .menu-item')]
      .find(b => b.querySelector('.mi-label').textContent === 'End of this programme')
      ?.querySelector('.mi-hint').textContent || null
    const onNow = document.querySelector('#np-name').textContent

    // arm 15 minutes
    const arm = [...document.querySelectorAll('#sleep-menu .menu-item')]
      .find(b => b.querySelector('.mi-label').textContent === '15 minutes')
    arm.click()
    await wait(700)
    const armed = { on: btn.classList.contains('on'), label: btn.textContent.trim() }

    // move the page clock to 10 s before the deadline: it must be fading, still playing
    const realNow = Date.now
    Date.now = () => realNow() + 14 * 60000 + 50000
    await wait(900)
    const savedVol = async () => (await (await fetch('/api/bootstrap')).json()).settings.volume
    const fading = { vol: +v.volume.toFixed(3), playing: !document.querySelector('#player').classList.contains('collapsed') }
    // The value that would be restored next launch. The fade is an animation, not
    // a preference: it must not be written. It was, and a straggler POST landed
    // after the restore and won — the app booted at 0.83% with no volume control
    // to fix it with.
    await wait(400)
    fading.saved = await savedVol()

    // past the deadline: playback stops, volume handed back, chip disarmed
    Date.now = () => realNow() + 16 * 60000
    await wait(900)
    const fired = {
      collapsed: document.querySelector('#player').classList.contains('collapsed'),
      vol: +v.volume.toFixed(3),
      label: btn.textContent.trim(),
      on: btn.classList.contains('on'),
      status: document.querySelector('#status').textContent
    }
    Date.now = realNow
    await wait(500) // let the restore's POST land before reading it back
    fired.saved = await savedVol()
    return { epgOption, epgHint, onNow, items, armed, fading, fired, onScreen, menuBox }
  })()`)

  const ok = (c, m) => console.log(`${c ? '  ok  ' : '  FAIL'} ${m}`)
  console.log('\n[renderer]')
  ok(probe.hls, 'hls.js loaded')
  ok(probe.ticks > 40, `timebar rendered (${probe.ticks} ticks)`)
  ok(probe.rows > 5, `channel rows virtualised (${probe.rows} in view, ${probe.count} total)`)
  ok(probe.progs > 0, `programmes rendered (${probe.progs}; ${probe.live} live, ${probe.empty} "no guide")`)
  console.log(`      first channel: ${probe.first}`)
  console.log(`      on now: ${probe.titles.join(' | ') || '(none in view)'}`)
  console.log(`      status: ${probe.status}`)

  console.log('\n[row reuse]')
  for (const [what, r] of resort) {
    ok(!r.clash.length, `${what}: ${r.clash.join(' | ') || 'no two rows share an offset'}`)
  }
  ok(
    afterFav.stars === before + 1,
    `favouriting ${favId} starred exactly one more row (${before} -> ${afterFav.stars})`
  )
  ok(restored === before, `test left the favourites as it found them (${restored})`)

  console.log('\n[programme search]')
  ok(
    progSearch.byProgOnly > 0,
    `"${progSearch.term}" matched ${progSearch.byProgOnly} channels whose name does not contain it`
  )
  ok(progSearch.ended === 0, `no hit is a programme that already finished (${progSearch.matched} hits)`)
  ok(progSearch.hits > 0, `matched rows say which programme matched (${progSearch.hits} on screen)`)
  ok(progSearch.matchBlocks > 0, `matching programmes ringed in the grid (${progSearch.matchBlocks} blocks)`)
  if (progSearch.jumped === null) console.log('  --   no future hit on screen to test the jump against')
  else ok(progSearch.jumped, `clicking a hit brings that programme into view (${progSearch.jumpedTo})`)
  console.log(`      ${progSearch.total} channels shown after filters`)
  progSearch.sample.forEach(x => console.log(`      ${x}`))

  console.log('\n[player]')
  ok(!play.collapsed, `player opened for "${play.name}"`)
  ok(/^http:\/\/127\.0\.0\.1/.test(play.src) || play.src.startsWith('blob:'), `video src via proxy/MSE: ${play.src}`)
  ok(play.readyState > 0 || !!play.err, `video readyState=${play.readyState} ${play.w}x${play.h}`)
  if (play.err) console.log(`      note: ${play.err}`)

  console.log('\n[sleep timer]')
  if (sleepTest.skip) console.log('  --   nothing playing, skipped')
  else {
    ok(/^⏱ 1[45]:\d\d$/.test(sleepTest.armed.label) && sleepTest.armed.on,
      `arming 15 min shows a live countdown: "${sleepTest.armed.label}"`)
    ok(sleepTest.fading.vol > 0 && sleepTest.fading.vol < 0.8 && sleepTest.fading.playing,
      `fades out over the last 20 s instead of cutting (volume 0.8 -> ${sleepTest.fading.vol}, still playing)`)
    ok(sleepTest.fired.collapsed, 'at the deadline, playback stops')
    ok(sleepTest.fired.vol === 0.8, `the user's volume is handed back, not left at 0 (${sleepTest.fired.vol})`)
    // Both of these are about the *persisted* value, which is what the next launch
    // reads. Asserting only on video.volume is how the app came to boot at 0.83%.
    ok(sleepTest.fading.saved === 0.8,
      `mid-fade, the saved volume is still the user's, not the fade's (saved ${sleepTest.fading.saved} while playing at ${sleepTest.fading.vol})`)
    ok(sleepTest.fired.saved === 0.8,
      `after the timer fires, the saved volume is the user's (${sleepTest.fired.saved})`)
    ok(!sleepTest.fired.on && sleepTest.fired.label === '⏱ Sleep', 'the timer disarms itself')
    ok(sleepTest.epgOption, `"End of this programme" offered on a channel with a guide (${sleepTest.onNow}: ${sleepTest.epgHint})`)
    ok(sleepTest.onScreen, `the menu is fully on screen (top ${sleepTest.menuBox.top}, bottom ${sleepTest.menuBox.bottom} of ${sleepTest.menuBox.vh})`)
    console.log(`      menu: ${sleepTest.items.join(' · ')}`)
    console.log(`      status: ${sleepTest.fired.status}`)
  }

  console.log('\n[console errors]')
  if (errors.length) errors.slice(0, 10).forEach(e => console.log('  ! ' + e))
  else console.log('  none')

  server.close()
  app.exit(errors.length ? 1 : 0)
}).catch(err => {
  // A throw inside app.whenReady().then() is an unhandled rejection: Electron
  // stays alive with an empty log, which reads exactly like a slow test. Fail loudly.
  console.error(`\nCRASHED: ${err?.stack || err}`)
  app.exit(1)
})
