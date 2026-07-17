'use strict'
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const dayjs = require('dayjs')
dayjs.extend(require('dayjs/plugin/utc'))

/**
 * Drives iptv-org's `epg-grabber` engine against vendored site configs.
 *
 * Two things make this cheap where a naive "bundle the scraper repo" is not:
 *
 *  - We skip iptv-org/epg's TypeScript CLI entirely and drive the `epg-grabber`
 *    engine in-process, whose deps are pure JS. No tsx, no @swc, no native
 *    binaries — and no child process. The `epg-grabber` *CLI* loads its config
 *    with import(), which cannot read a Windows absolute path (it needs a
 *    file:// URL) nor an app.asar path at all; require()-ing the config in-
 *    process sidesteps both, so this actually runs on the platform we ship.
 *  - We *generate* the channels.xml, containing only the channels the user is
 *    actually missing a guide for. A full-site scrape is hours; 60 favourites
 *    is seconds. And because we choose `xmltv_id`, the scraped output keys
 *    straight to our catalog — no name matching at all.
 *
 * Configs are vendored (pinned) rather than downloaded at runtime: they are
 * executable JS, and fetching+require-ing remote code on a user's machine is
 * not something that belongs in an installer.
 */
/**
 * asarUnpack keeps vendor/** and node_modules/** as real files beside the
 * archive, so a path that resolves *into* app.asar won't find them there.
 * Redirect to the unpacked copy for anything we readdir or require off disk.
 * Identity in dev, where there is no asar.
 */
const unpacked = p => {
  if (!p.includes('app.asar')) return p
  const alt = p.replace(/app\.asar(?![.\w])/, 'app.asar.unpacked')
  return fs.existsSync(alt) ? alt : p
}

class Scraper {
  constructor({ catalog, epg, sitesDir, workDir, onStatus }) {
    this.catalog = catalog
    this.epg = epg
    this.sitesDir = unpacked(sitesDir)
    this.workDir = workDir
    this.onStatus = onStatus || (() => {})
    this.state = { running: false, site: null, log: [], done: null, error: null }
    fs.mkdirSync(workDir, { recursive: true })
  }

  /** Which vendored sites exist, and what each would add for this catalog. */
  sites() {
    const files = fs
      .readdirSync(this.sitesDir)
      .filter(f => f.endsWith('.config.js'))
      .map(f => f.replace(/\.config\.js$/, ''))

    const guides = this.catalog.raw.guides
    const out = []
    for (const site of files) {
      const rows = guides.filter(g => g.site === site && g.channel && this.catalog.byId.has(g.channel))
      const channels = new Set(rows.map(g => g.channel))
      const missing = [...channels].filter(id => !this.epg.programmes.has(id))
      out.push({
        site,
        covers: channels.size,
        missing: missing.length, // channels this site could fill that have no guide today
        langs: [...new Set(rows.map(g => g.lang).filter(Boolean))].slice(0, 4)
      })
    }
    return out.sort((a, b) => b.missing - a.missing)
  }

  status() {
    return { ...this.state, log: this.state.log.slice(-40) }
  }

  _log(line) {
    this.state.log.push(line)
    this.onStatus(line)
  }

  /**
   * @param {string}   site      vendored site key, e.g. "tvtv.us"
   * @param {string[]} channelIds explicit channels; default = every channel this
   *                              site can cover that currently has no guide
   * @param {number}   days
   */
  async run({ site, channelIds = null, days = 2 }) {
    if (this.state.running) throw new Error('a scrape is already running')

    const configPath = path.join(this.sitesDir, `${site}.config.js`)
    if (!fs.existsSync(configPath)) throw new Error(`unknown site: ${site}`)

    // guides.json maps (channel, site) -> site_id, which is what the config needs.
    const rows = this.catalog.raw.guides.filter(
      g => g.site === site && g.channel && this.catalog.byId.has(g.channel)
    )
    const wanted = channelIds
      ? new Set(channelIds)
      : new Set(rows.map(g => g.channel).filter(id => !this.epg.programmes.has(id)))

    const picked = []
    const seen = new Set()
    for (const g of rows) {
      if (!wanted.has(g.channel)) continue
      const key = `${g.channel}|${g.site_id}`
      if (seen.has(key)) continue
      seen.add(key)
      picked.push(g)
    }

    if (!picked.length) throw new Error('nothing to grab — every channel this site covers already has a guide')

    this.state = { running: true, site, log: [], done: null, error: null }
    this._log(`${site}: preparing ${picked.length} channels…`)

    const esc = s =>
      String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]))

    // xmltv_id is OURS — the iptv-org channel id — so output joins directly.
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n' +
      picked
        .map(g => {
          const name = this.catalog.byId.get(g.channel)?.name || g.channel
          return `  <channel site="${esc(site)}" lang="${esc(g.lang || 'en')}" xmltv_id="${esc(
            g.channel
          )}" site_id="${esc(g.site_id)}">${esc(name)}</channel>`
        })
        .join('\n') +
      '\n</channels>\n'

    const outFile = path.join(this.workDir, `${site}.guide.xml`)

    // epg-grabber is itself ESM (Electron's Node can't require() it), so import
    // it. The *config*, by contrast, is CommonJS and is loaded with require() —
    // which reads both Windows absolute paths and app.asar, where epg-grabber's
    // own import()-based config loader reads neither. delete-from-cache lets a
    // second run pick up an edited config.
    const { EPGGrabber } = await this._loadGrabber()
    delete require.cache[require.resolve(configPath)]
    const config = require(configPath)
    if (config.request && typeof config.request === 'object') {
      config.request = { timeout: 15000, ...config.request }
    }

    const channels = EPGGrabber.parseChannelsXML(xml)
    const grabber = new EPGGrabber(config)

    // grab one UTC day at a time, mirroring the CLI: [today, +1, … +days-1].
    const base = dayjs.utc().startOf('day')
    const dates = Array.from({ length: days }, (_, i) => base.add(i, 'day'))
    const queue = []
    for (const ch of channels) for (const date of dates) queue.push({ ch, date })

    const programmes = []
    let done = 0
    const total = queue.length
    this._cancelled = false
    this._log(`${site}: grabbing ${days} day(s)…`)

    // a small pool keeps it polite; epg-grabber resolves grab() with [] and
    // reports the failure through the callback rather than throwing.
    const worker = async () => {
      for (;;) {
        if (this._cancelled) return
        const item = queue.shift()
        if (!item) return
        const rows = await grabber
          .grab(item.ch, item.date, (ctx, err) => {
            done++
            this._log(
              `[${done}/${total}] ${item.ch.site} ${item.ch.xmltv_id} ` +
                `${item.date.format('MMM D')} — ${ctx.programs.length} programs`
            )
            if (err) this._log(`  ${err.message}`)
          })
          .catch(err => {
            this._log(`  ${item.ch.xmltv_id}: ${err.message}`)
            return []
          })
        programmes.push(...rows)
      }
    }
    await Promise.all(Array.from({ length: 5 }, worker))
    if (this._cancelled) throw new Error('scrape cancelled')

    const xmltv = EPGGrabber.generateXMLTV(channels, programmes, { date: base.format('YYYYMMDD') })
    await fsp.writeFile(outFile, xmltv, 'utf8')

    // xmltv_id === our channel id, so the map is the identity over picked channels.
    const idMap = new Map([...wanted].map(id => [id, id]))
    const res = await this.epg.mergeLocal(outFile, idMap, site)

    this.state.running = false
    this.state.done = { site, ...res }
    this._log(`${site}: added ${res.programmes} programmes across ${res.channels} channels`)
    return res
  }

  cancel() {
    // in-flight grab() calls finish, but the worker loop stops pulling new work
    this._cancelled = true
    this.state.running = false
  }

  /**
   * Import the ESM epg-grabber engine from its *unpacked* entry. A bare
   * `import('epg-grabber')` from inside app.asar resolves to a path the ESM
   * loader can't read; walking node_modules for the manifest and importing its
   * exports entry through a file:// URL points at the real file on disk.
   */
  async _loadGrabber() {
    const roots = [path.join(__dirname, '..', '..', 'node_modules'), ...(module.paths || [])]
    for (const root of roots) {
      const dir = unpacked(path.join(root, 'epg-grabber'))
      const manifest = path.join(dir, 'package.json')
      if (!fs.existsSync(manifest)) continue
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      const dot = pkg.exports && pkg.exports['.']
      const rel = (dot && (dot.import || dot.default)) || pkg.module || pkg.main
      if (!rel) continue
      const entry = unpacked(path.join(dir, rel))
      return import(pathToFileURL(entry).href)
    }
    throw new Error('epg-grabber not found — reinstall dependencies')
  }
}

module.exports = { Scraper }
