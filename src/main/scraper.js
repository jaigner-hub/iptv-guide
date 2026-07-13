'use strict'
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')

/**
 * Drives iptv-org's `epg-grabber` engine against vendored site configs.
 *
 * Two things make this cheap where a naive "bundle the scraper repo" is not:
 *
 *  - We skip iptv-org/epg's TypeScript CLI entirely and call the `epg-grabber`
 *    npm package, whose deps are pure JS. No tsx, no @swc, no native binaries.
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
 * Node's ESM loader cannot read from inside an app.asar archive, and epg-grabber
 * is ESM. Anything handed to the child process must therefore point at the
 * unpacked copy. Harmless in dev, where no asar path exists.
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

    const chFile = path.join(this.workDir, `${site}.channels.xml`)
    const outFile = path.join(this.workDir, `${site}.guide.xml`)
    await fsp.writeFile(chFile, xml, 'utf8')

    const bin = this._grabberBin()
    const args = [
      bin,
      `--config=${configPath}`,
      `--channels=${chFile}`,
      `--output=${outFile}`,
      `--days=${days}`,
      '--delay=250',
      '--max-connections=5',
      '--timeout=15000'
    ]

    this._log(`${site}: grabbing ${days} day(s)…`)

    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: this.workDir,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      this._child = child

      const onLine = buf => {
        for (const line of String(buf).split(/\r?\n/)) {
          const t = line.trim()
          if (t) this._log(t.slice(0, 200))
        }
      }
      child.stdout.on('data', onLine)
      child.stderr.on('data', onLine)
      child.on('error', reject)
      child.on('close', code =>
        code === 0 ? resolve() : reject(new Error(`epg-grabber exited with code ${code}`))
      )
    })

    if (!fs.existsSync(outFile)) throw new Error('grabber produced no output')

    // xmltv_id === our channel id, so the map is the identity over picked channels.
    const idMap = new Map([...wanted].map(id => [id, id]))
    const res = await this.epg.mergeLocal(outFile, idMap, site)

    this.state.running = false
    this.state.done = { site, ...res }
    this._log(`${site}: added ${res.programmes} programmes across ${res.channels} channels`)
    return res
  }

  cancel() {
    if (this._child) this._child.kill()
    this.state.running = false
  }

  _grabberBin() {
    // epg-grabber declares an "exports" map, so require.resolve() can't reach its
    // package.json. Walk node_modules roots and read the manifest off disk instead.
    const roots = [
      path.join(__dirname, '..', '..', 'node_modules'),
      ...(module.paths || [])
    ]
    for (const root of roots) {
      const dir = unpacked(path.join(root, 'epg-grabber'))
      const manifest = path.join(dir, 'package.json')
      if (!fs.existsSync(manifest)) continue
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      const rel = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin || {})[0]
      if (rel) return path.join(dir, rel)
    }
    throw new Error('epg-grabber not found — reinstall dependencies')
  }
}

module.exports = { Scraper }
