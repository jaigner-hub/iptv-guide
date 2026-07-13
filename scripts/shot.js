'use strict'
/** Screenshot the real UI and dump element geometry, to debug layout by observation. */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const { Store, Settings } = require('../src/main/store')
const { Catalog } = require('../src/main/catalog')
const { Epg } = require('../src/main/epg')
const { Scraper } = require('../src/main/scraper')
const { createServer } = require('../src/main/server')

app.whenReady().then(async () => {
  const dir = path.join(__dirname, '..', '.selftest')
  const store = new Store(path.join(dir, 'cache'))
  const settings = new Settings(path.join(dir, 'settings.json'), { scope: 'default', country: '', favorites: [] })
  const catalog = new Catalog(store)
  await catalog.load()
  const epg = new Epg(store, catalog)
  await epg.loadCached()
  const scraper = new Scraper({ catalog, epg, sitesDir: path.join(__dirname, '..', 'vendor', 'sites'), workDir: path.join(dir, 'guides'), onStatus: () => {} })
  const { server } = createServer({ catalog, epg, settings, scraper, rendererDir: path.join(__dirname, '..', 'src', 'renderer'), onStatus: () => {} })
  await new Promise(r => server.listen(0, '127.0.0.1', r))

  const win = new BrowserWindow({
    show: false, width: 1400, height: 900,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  })
  await win.loadURL(`http://127.0.0.1:${server.address().port}/`)
  await new Promise(r => setTimeout(r, 4000))

  const snap = async (name, js) => {
    if (js) await win.webContents.executeJavaScript(js)
    await new Promise(r => setTimeout(r, js ? 6000 : 500))
    const out = path.join(dir, `shot-${name}.png`)
    fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG())
    const g = await win.webContents.executeJavaScript(`(() => {
      const R = s => document.querySelector(s).getBoundingClientRect()
      const p = R('#player'), vr = R('#video'), side = R('.player-side'), ctl = R('.player-controls')
      const v = document.querySelector('#video')
      const gd = document.querySelector('.guide')?.getBoundingClientRect()
      return {
        playerH: Math.round(p.height),
        videoSize: v.videoWidth + 'x' + v.videoHeight,
        // the video box must stay inside the player pane, and letterbox not crop
        videoBox: Math.round(vr.width) + 'x' + Math.round(vr.height),
        videoFits: vr.bottom <= p.bottom + 1 && vr.top >= p.top - 1,
        objectFit: getComputedStyle(v).objectFit,
        // controls must be fully inside the side panel at every pane height
        controlsVisible: ctl.height > 0 && ctl.bottom <= side.bottom + 1,
        controlsOverflow: Math.round(ctl.bottom - side.bottom),
        guideVisible: !!gd && gd.height > 0,
        playing: !v.paused
      }
    })()`)
    console.log(`  ${name.padEnd(10)} ${JSON.stringify(g)}`)
    return g
  }

  console.log('\n[layout states]')
  const states = [
    await snap('play', `document.querySelectorAll('#chancol-inner .chan')[1]?.click()`),
    await snap('small', `document.documentElement.style.setProperty('--player-h','260px')`),
    await snap('tiny', `document.documentElement.style.setProperty('--player-h','190px')`)
  ]
  const bad = states.filter(s => !s.controlsVisible || !s.videoFits)
  console.log(bad.length ? `  FAIL ${bad.length} state(s) clip the player` : '  ok   controls + video fit at every height')

  // the "Guide only" filter must survive without scrolling the whole list
  const epgOnly = await win.webContents.executeJavaScript(`(async () => {
    const before = document.querySelectorAll('#chancol-inner .chan').length
    document.querySelector('#f-epg').click()
    await new Promise(r => setTimeout(r, 400))
    const count = document.querySelector('#chan-count').textContent
    document.querySelector('#f-epg').click()
    return { count, before }
  })()`)
  console.log(`\n[guide-only filter] ${JSON.stringify(epgOnly)}`)

  const geom = await win.webContents.executeJavaScript(`(() => {
    const R = s => { const e = document.querySelector(s); if (!e) return null
      const r = e.getBoundingClientRect()
      return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), t: Math.round(r.top) } }
    const progs = [...document.querySelectorAll('#grid-inner .prog')].slice(0, 4).map(p => {
      const r = p.getBoundingClientRect()
      return { txt: (p.textContent || '').slice(0, 18), l: Math.round(r.left), w: Math.round(r.width) }
    })
    return {
      guideCols: getComputedStyle(document.querySelector('.guide')).gridTemplateColumns,
      chanW: getComputedStyle(document.documentElement).getPropertyValue('--chan-w'),
      corner: R('.guide-corner'), chancol: R('#chancol'), timebar: R('#timebar'), grid: R('#grid'),
      firstChan: R('#chancol-inner .chan'), gridScrollLeft: document.querySelector('#grid').scrollLeft,
      progs
    }
  })()`)
  console.log(JSON.stringify(geom, null, 2))

  const img = await win.webContents.capturePage()
  const out = path.join(__dirname, '..', '.selftest', 'shot.png')
  fs.writeFileSync(out, img.toPNG())
  console.log('\nwrote ' + out)

  server.close()
  app.exit(0)
})
