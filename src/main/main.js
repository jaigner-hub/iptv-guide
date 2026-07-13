'use strict'
const { app, BrowserWindow, Tray, Menu, shell, ipcMain, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const { Store, Settings } = require('./store')
const { Catalog } = require('./catalog')
const { Epg } = require('./epg')
const { Scraper } = require('./scraper')
const { createServer } = require('./server')

const DEV = process.argv.includes('--dev')

let win = null
let tray = null
let server = null
let port = 0
let quitting = false

const userData = app.getPath('userData')
const store = new Store(path.join(userData, 'cache'))
const settings = new Settings(path.join(userData, 'settings.json'), {
  scope: 'default', // 'default' = US + English, 'all'
  country: '', // the scope filter already covers US+English; don't narrow twice
  category: '',
  favorites: [],
  lastChannel: null,
  volume: 1,
  hideNsfw: true
})

const catalog = new Catalog(store)
const epg = new Epg(store, catalog)
let scraper = null

const status = msg => {
  if (DEV) console.log('[status]', msg)
  if (win && !win.isDestroyed()) win.webContents.send('status', msg)
}

// The window must never wait on the network. The server is started first — it
// needs nothing but a port — so the UI is on screen within a second and can
// report what the catalog download is doing, including failing at it.
let boot = { ready: false, status: 'Starting…', error: null }

async function startServer() {
  scraper = new Scraper({
    catalog,
    epg,
    sitesDir: path.join(__dirname, '..', '..', 'vendor', 'sites'),
    workDir: path.join(userData, 'guides'),
    onStatus: status
  })

  const rendererDir = path.join(__dirname, '..', 'renderer')
  const created = createServer({
    catalog,
    epg,
    settings,
    scraper,
    rendererDir,
    onStatus: status,
    bootState: () => boot,
    onRetry: () => loadCatalog()
  })
  server = created.server

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  if (DEV) console.log(`server -> http://127.0.0.1:${port}`)
}

async function loadCatalog() {
  if (boot.ready || boot.loading) return
  boot = { ready: false, loading: true, status: 'Starting…', error: null }

  const step = msg => {
    boot.status = msg
    status(msg)
  }

  try {
    await catalog.load({ onProgress: step })
    const had = await epg.loadCached()
    boot = { ready: true, loading: false, status: '', error: null }
    status(`Catalog: ${catalog.channels.length} channels with streams`)
    if (had) status(`Guide: ${epg.programmes.size} channels (cached)`)

    // Refresh the guide in the background; the UI is usable meanwhile.
    if (!had || epg.isStale()) {
      epg.refresh({ onProgress: status }).catch(err => status(`Guide error: ${err.message}`))
    }
  } catch (err) {
    // Surfaced in the window with a Try again button, not swallowed into a
    // console no one reads.
    boot = { ready: false, loading: false, status: '', error: err.message }
    status(`Startup failed: ${err.message}`)
  }
}

function iconImage() {
  for (const f of ['icon.png', 'icon.ico']) {
    const p = path.join(__dirname, '..', '..', 'build', f)
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p)
      if (!img.isEmpty()) return img
    }
  }
  return nativeImage.createEmpty()
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    icon: iconImage(),
    title: 'IPTV Guide',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.loadURL(`http://127.0.0.1:${port}/`)
  if (DEV) win.webContents.openDevTools({ mode: 'detach' })

  // Closing hides to tray — this is a "leave it running" kind of app.
  win.on('close', e => {
    if (quitting) return
    e.preventDefault()
    win.hide()
  })

  // External links open in the real browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

function showWindow() {
  // Never build a window before the server has a port: a second click during
  // startup used to open one pointed at http://127.0.0.1:0/ — a dead window
  // the user then judged the app by.
  if (!port) return
  if (!win || win.isDestroyed()) createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function createTray() {
  tray = new Tray(iconImage())
  tray.setToolTip('IPTV Guide')
  const menu = Menu.buildFromTemplate([
    { label: 'Open Guide', click: showWindow },
    { type: 'separator' },
    {
      label: 'Refresh guide data',
      click: () => {
        status('Refreshing guide…')
        epg.refresh({ onProgress: status }).catch(e => status(`Guide error: ${e.message}`))
      }
    },
    {
      label: 'Open in browser',
      click: () => port && shell.openExternal(`http://127.0.0.1:${port}/`)
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
  tray.on('click', showWindow)
  tray.on('double-click', showWindow)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  app.whenReady().then(async () => {
    await startServer() // local only; cannot fail on a bad network
    createWindow()
    createTray()
    loadCatalog() // deliberately not awaited — the window is already up
  })

  app.on('window-all-closed', () => {
    // stay alive in the tray; quit is explicit
  })

  app.on('activate', showWindow)

  app.on('before-quit', () => {
    quitting = true
    scraper?.cancel()
    server?.close()
  })
}

ipcMain.handle('app:info', () => ({
  port,
  version: app.getVersion(),
  userData
}))
ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(url))
ipcMain.handle('app:quit', () => {
  quitting = true
  app.quit()
})
