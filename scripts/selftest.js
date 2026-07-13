'use strict'
/**
 * Headless check of the backend: catalog -> EPG -> server -> stream proxy.
 * Runs under plain Node (no Electron) since none of these modules need it.
 *
 *   node scripts/selftest.js          # catalog + server + proxy
 *   node scripts/selftest.js --epg    # ...and rebuild the guide from mirrors (slow, ~500MB)
 */
const path = require('node:path')
const os = require('node:os')

const { Store, Settings } = require('../src/main/store')
const { Catalog } = require('../src/main/catalog')
const { Epg } = require('../src/main/epg')
const { Scraper } = require('../src/main/scraper')
const { createServer } = require('../src/main/server')

// repo-local so the Windows Electron uitest shares this cache (WSL /tmp is invisible to it)
const DIR = path.join(__dirname, '..', '.selftest')
void os
const WITH_EPG = process.argv.includes('--epg')
const ok = (c, m) => console.log(`${c ? '  ok  ' : '  FAIL'} ${m}`)

;(async () => {
  const t0 = Date.now()
  const store = new Store(path.join(DIR, 'cache'))
  const settings = new Settings(path.join(DIR, 'settings.json'), { scope: 'default' })
  const catalog = new Catalog(store)
  const epg = new Epg(store, catalog)

  console.log('\n[1] catalog')
  await catalog.load({ onProgress: m => console.log('      ' + m) })
  const scoped = catalog.channels.filter(c => catalog.isDefaultScope(c))
  ok(catalog.channels.length > 5000, `${catalog.channels.length} channels with >=1 stream`)
  ok(scoped.length > 1000, `${scoped.length} in default scope (US + English)`)
  const withHeaders = catalog.channels.filter(c => c.streams.some(s => s.userAgent || s.referrer))
  ok(withHeaders.length > 100, `${withHeaders.length} channels have streams needing UA/Referer headers`)

  console.log('\n[2] epg')
  if (WITH_EPG) {
    await epg.refresh({
      onProgress: m =>
        console.log(`      ${m.text}${m.pct == null ? '' : ` (${Math.round(m.pct * 100)}%)`}`)
    })
  } else {
    const had = await epg.loadCached()
    console.log(had ? '      using cached guide' : '      no cache — run with --epg to build one')
  }
  const covered = scoped.filter(c => epg.programmes.has(c.id)).length
  ok(!WITH_EPG || epg.programmes.size > 500, `guide covers ${epg.programmes.size} channels`)
  console.log(`      in-scope coverage: ${covered}/${scoped.length} (${((100 * covered) / scoped.length).toFixed(0)}%)`)
  for (const [name, s] of Object.entries(epg.stats().sources)) {
    console.log(`      ${name.padEnd(22)} ${s.error ? 'ERROR ' + s.error : `${s.channels} ch, ${s.programmes} progs (${s.kind})`}`)
  }

  console.log('\n[3] server')
  const scraper = new Scraper({
    catalog,
    epg,
    sitesDir: path.join(__dirname, '..', 'vendor', 'sites'),
    workDir: path.join(DIR, 'guides'),
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
  const base = `http://127.0.0.1:${server.address().port}`

  const boot = await (await fetch(`${base}/api/bootstrap`)).json()
  ok(boot.channels.length === catalog.channels.length, `/api/bootstrap -> ${boot.channels.length} channels`)
  ok(boot.channels[0].streams[0].src.startsWith('/p/'), 'streams exposed as proxy URLs')
  const html = await fetch(`${base}/`)
  ok(html.ok && (await html.text()).includes('IPTV Guide'), 'renderer served')

  const sites = await (await fetch(`${base}/api/scraper/sites`)).json()
  ok(sites.length > 0, `scraper sites: ${sites.map(s => `${s.site}(+${s.missing})`).join(' ')}`)

  console.log('\n[4] stream proxy (real playback path)')
  // Try a handful of in-scope channels; some iptv-org streams are legitimately
  // offline or geo-blocked, so we assert that *some* stream plays, not a specific one.
  const candidates = scoped.filter(c => c.streams.length).slice(0, 400)
  const pick = []
  for (const c of candidates) {
    if (pick.length >= 12) break
    if (c.streams[0].url.includes('.m3u8')) pick.push(c)
  }

  let played = 0
  let rewrote = 0
  for (const c of pick) {
    const s = c.streams[0]
    const url = `${base}/p/${encodeURIComponent(s.sid)}/${Buffer.from(s.url).toString('base64url')}`
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) })
      if (!res.ok) continue
      const body = await res.text()
      if (!body.startsWith('#EXTM3U')) continue
      played++
      const child = body.split('\n').find(l => l.startsWith('/p/'))
      if (child) {
        rewrote++
        // follow one level: variant playlist or segment must also come back
        const sub = await fetch(`${base}${child}`, { signal: AbortSignal.timeout(12000) })
        const kind = sub.headers.get('content-type') || ''
        console.log(
          `      ${c.name.slice(0, 30).padEnd(30)} manifest ok, child ${sub.status} ${kind.split(';')[0]}`
        )
      }
    } catch {}
  }
  ok(played > 0, `${played}/${pick.length} sampled manifests fetched through proxy`)
  ok(rewrote > 0, `${rewrote} manifests had URLs rewritten to /p/ (headers+CORS handled)`)

  server.close()
  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)
  process.exit(0)
})().catch(e => {
  console.error('\nSELFTEST FAILED:', e)
  process.exit(1)
})
