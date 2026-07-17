'use strict'
/**
 * The on-demand guide scraper, exercised end-to-end against a real listings
 * site. Runs under Electron on purpose: epg-grabber is ESM and loads its site
 * config the way Node does on the platform we ship, and the bug this guards was
 * invisible under WSL Node — `epg-grabber`'s CLI feeds the config path to
 * import(), which rejects a Windows absolute path (needs file://) and cannot
 * read app.asar at all, so *every* site failed with ERR_UNSUPPORTED_ESM_URL_
 * SCHEME on Windows while passing on Linux. scraper.js now drives the engine
 * in-process and require()s the config. Revert that and this test fails.
 *
 *   npx electron scripts/scrapetest.js
 *
 * Needs a catalog cache (run selftest first) and network access to tvhebdo.com.
 */
const path = require('node:path')
const fs = require('node:fs')
const { app } = require('electron')

const { Store } = require('../src/main/store')
const { Catalog } = require('../src/main/catalog')
const { Epg } = require('../src/main/epg')
const { Scraper } = require('../src/main/scraper')

const DIR = path.join(__dirname, '..', '.selftest')
const CH = 'WGNDT1.us' // WGN-DT1: no mjh/epgshare match, but tvhebdo.com lists it
const SITE = 'tvhebdo.com'

const ok = (c, m) => console.log(`${c ? '  ok  ' : '  FAIL'} ${m}`)

app.whenReady().then(async () => {
  if (!fs.existsSync(path.join(DIR, 'cache', 'catalog.json.gz'))) {
    throw new Error('no catalog cache — run `node scripts/selftest.js` first')
  }

  // Catalog reads the shared cache; the EPG writes to a throwaway store so the
  // scrape never clobbers the guide cache the other tests rely on.
  const catStore = new Store(path.join(DIR, 'cache'))
  fs.rmSync(path.join(DIR, 'scrapetest-cache'), { recursive: true, force: true })
  const epgStore = new Store(path.join(DIR, 'scrapetest-cache'))

  const catalog = new Catalog(catStore)
  await catalog.load()
  ok(catalog.byId.has(CH), `${CH} is in the catalog`)

  const epg = new Epg(epgStore, catalog)
  await epg.loadCached()
  ok(!epg.programmes.has(CH), `${CH} has no guide before the scrape`)

  const scraper = new Scraper({
    catalog,
    epg,
    sitesDir: path.join(__dirname, '..', 'vendor', 'sites'),
    workDir: path.join(DIR, 'scrapetest-work'),
    onStatus: m => console.log('      ' + m)
  })

  const listed = scraper.sites().find(s => s.site === SITE)
  ok(!!listed, `scraper advertises ${SITE} (covers ${listed?.covers})`)

  const res = await scraper.run({ site: SITE, channelIds: [CH], days: 1 })
  const rows = epg.programmes.get(CH) || []
  ok(rows.length > 0, `${SITE} filled ${CH}: ${res.programmes} programmes merged`)
  rows.slice(0, 3).forEach(p => console.log(`        ${new Date(p.s).toISOString()}  ${p.t}`))

  if (!rows.length) throw new Error(`scrape produced no guide for ${CH}`)
  console.log('\ndone')
  app.exit(0)
}).catch(err => {
  console.error('scrapetest failed:', (err && err.stack) || err)
  app.exit(1)
})
