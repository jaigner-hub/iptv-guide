'use strict'
const { fetchXmltv } = require('./xmltv')
const { normName } = require('./catalog')

const WINDOW_BACK_MS = 6 * 60 * 60 * 1000
const WINDOW_FWD_MS = 72 * 60 * 60 * 1000

// Each refresh pulls a 184MB feed. Doing that every 6 hours re-downloaded the
// whole guide most times the app opened, so this is the hard ceiling on age.
const REFRESH_MS = 24 * 60 * 60 * 1000

// ...but age is the wrong question on its own. The mirrors advertise 72 hours,
// yet that is the *deepest* channel: the median one only carries ~12-24 h, and
// 12 h after a fetch it is down to about 1 h of listings. So also refresh once
// the median channel has less than this left, or the viewer opens the app to a
// grid of "No guide data".
const MIN_FORWARD_MS = 3 * 60 * 60 * 1000

// share of the progress bar owned by the big epgshare download; the rest is mjh
const MJH_START = 0.85

// Bump when the join logic changes: a cache built by an older, looser matcher
// holds mis-bound listings, and silently serving them is worse than a refetch.
const EPG_VERSION = 2

/**
 * iptv-org publishes no usable guide feed of its own (guides.json is a scraper
 * recipe index — its `sources` field is populated on 2 of ~180k rows). So the
 * guide is assembled from public XMLTV mirrors, resolved in layers:
 *
 *   1. i.mjh.nz  — EXACT join. guides.json gives site_id "<path>#<xmltvId>";
 *                  the path is literally the file to fetch. No guessing.
 *   2. epgshare01 — name match. Covers traditional broadcast (CNN/ESPN/…)
 *                  that mjh's FAST-channel focus misses.
 *   3. local     — guides scraped on-demand via the bundled grabber.
 *
 * Layers are applied lowest-confidence-first so a better source overwrites a
 * worse one for the same channel.
 */
const EPGSHARE_ALL = 'https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz'

class Epg {
  constructor(store, catalog) {
    this.store = store
    this.catalog = catalog
    this.programmes = new Map() // channelId -> [{s,e,t,d,c,i}]
    this.sources = {} // name -> { channels, programmes, error }
    this.updatedAt = 0
    this.progress = { active: false, text: '', pct: null }
  }

  async loadCached() {
    const cached = await this.store.read('epg')
    if (!cached || cached.version !== EPG_VERSION) return false // stale join logic
    this.hydrate(cached)
    return true
  }

  hydrate(data) {
    this.programmes = new Map()
    for (const [ch, rows] of Object.entries(data.programmes || {})) {
      this.programmes.set(
        ch,
        rows.map(r => ({ s: r[0], e: r[1], t: r[2], d: r[3], c: r[4], i: r[5] }))
      )
    }
    this.sources = data.sources || {}
    this.updatedAt = data.updatedAt || 0
  }

  serialize() {
    const programmes = {}
    for (const [ch, rows] of this.programmes) {
      programmes[ch] = rows.map(p => [p.s, p.e, p.t, p.d, p.c, p.i])
    }
    return { version: EPG_VERSION, updatedAt: this.updatedAt, sources: this.sources, programmes }
  }

  /**
   * Refresh when the guide is old, or when it has actually run out.
   *
   * "Run out" has to be measured on the *median* channel, not the furthest one.
   * Taking the max meant a single channel with listings three days out kept the
   * whole guide "fresh" while a third of the channels had nothing left to show —
   * the grid filled up with "No guide data" and the guide looked broken. The
   * mirrors only carry ~12-24 h forward for a typical channel, so half of them
   * are down to ~1 h of listings just 12 h after a fetch.
   */
  isStale() {
    const now = Date.now()
    if (this.programmes.size === 0) return true
    if (now - this.updatedAt > REFRESH_MS) return true
    return this.forwardCoverage(now) < MIN_FORWARD_MS
  }

  /** How far ahead the median channel's listings run, in ms. */
  forwardCoverage(now = Date.now()) {
    const left = []
    for (const rows of this.programmes.values()) {
      const last = rows[rows.length - 1]
      left.push(last ? last.e - now : 0)
    }
    if (!left.length) return 0
    left.sort((a, b) => a - b)
    return left[left.length >> 1]
  }

  /** Merge programmes for one channel into `target`, sorted and deduped. */
  _merge(target, channelId, rows, { overwrite }) {
    if (!rows.length) return
    if (!overwrite && target.has(channelId)) return
    rows.sort((a, b) => a.s - b.s || a.e - b.e)

    // feeds do repeat themselves; a row listed twice renders as a doubled cell
    const out = []
    for (const p of rows) {
      const last = out[out.length - 1]
      if (last && last.s === p.s && last.t === p.t) continue
      out.push(p)
    }
    target.set(channelId, out)
  }

  async refresh({ onProgress = () => {} } = {}) {
    if (this.busy) return this.stats()
    this.busy = true

    const now = Date.now()
    const lo = now - WINDOW_BACK_MS
    const hi = now + WINDOW_FWD_MS
    const inWindow = p => p.stop > lo && p.start < hi && Number.isFinite(p.start)

    // Progress is reported as a single 0..1 fraction across both layers. The
    // epgshare feed is ~90% of the wall-clock, so it gets most of the bar.
    const report = (text, pct = null) => {
      this.progress = { active: true, text, pct }
      onProgress({ text, pct })
    }

    // Build into a staging map and swap at the end. Clearing the live one first
    // would blank every row in the guide for the ~90s the download takes.
    const staged = new Map()
    const sources = {}

    try {
      // ---- layer 2 first (weaker), so layer 1 can overwrite it ---------------
      await this._grabEpgshare({ inWindow, report, staged, sources })
      await this._grabMjh({ inWindow, report, staged, sources })

      this.programmes = staged
      this.sources = sources
      this.updatedAt = Date.now()
      report('Saving guide…', 0.99)
      await this.store.write('epg', this.serialize())

      const done = `Guide ready — ${this.programmes.size} channels`
      this.progress = { active: false, text: done, pct: 1 }
      onProgress({ text: done, pct: 1 })
      return this.stats()
    } catch (err) {
      this.progress = { active: false, text: `Guide error: ${err.message}`, pct: null }
      throw err
    } finally {
      this.busy = false
    }
  }

  /**
   * mjh's file paths name a region: "Plex/us", "PlutoTV/de", "Roku/all". The
   * same FAST channel is carried in many regions with different schedules, so
   * a US channel must not be handed the Plex/es or PlutoTV/de listing. These
   * services have no country in the path, so they're spelled out.
   */
  static MJH_REGION = {
    'Foxtel/epg': 'AU',
    'Binge/epg': 'AU',
    'Flash/epg': 'AU',
    'SkyGo/epg': 'NZ',
    'SkySportNow/epg': 'NZ',
    'MeTV/epg': 'US'
  }

  _mjhRegion(p) {
    if (Epg.MJH_REGION[p]) return Epg.MJH_REGION[p]
    if (p.startsWith('au/')) return 'AU'
    const last = p.split('/').pop().toLowerCase()
    if (!/^[a-z]{2}$/.test(last)) return null // "all", "epg" — region-neutral
    return last === 'gb' ? 'UK' : last.toUpperCase() // iptv-org says UK, not GB
  }

  /** Layer 1: exact join via guides.json site_id ("<path>#<xmltvId>"). */
  async _grabMjh({ inWindow, report, staged, sources }) {
    const guides = this.catalog.raw.guides.filter(g => g.site === 'i.mjh.nz' && g.channel)

    // xmltvId -> Set(channelId), and which files we need
    const wanted = new Map()
    const files = new Map()
    for (const g of guides) {
      const [path, xid] = String(g.site_id || '').split('#')
      if (!path || !xid) continue
      if (!this.catalog.byId.has(g.channel)) continue
      if (!wanted.has(xid)) wanted.set(xid, new Set())
      wanted.get(xid).add(g.channel)
      files.set(path, (files.get(path) || 0) + 1)
    }

    const filled = new Map() // channelId -> { rows, region, rank }
    const paths = [...files.keys()]
    let done = 0

    // a region that matches the channel beats a neutral feed, which beats a
    // foreign one; among equals, the fuller listing wins
    const rankOf = (region, channelId) => {
      const c = this.catalog.byId.get(channelId)
      if (!region || !c?.country) return 1
      return region === c.country ? 2 : 0
    }

    // modest concurrency — these are ~40 small files
    const queue = [...paths]
    const worker = async () => {
      for (;;) {
        const p = queue.shift()
        if (!p) return
        const url = `https://i.mjh.nz/${p}.xml.gz`
        const byCh = new Map()
        const owner = new Map() // channelId -> the xmltvId that claimed it here
        try {
          await fetchXmltv(url, {
            onProgramme: prog => {
              const chans = wanted.get(prog.channel)
              if (!chans || !inWindow(prog)) return
              for (const cid of chans) {
                // One file can carry the same channel under two xmltv ids (the
                // same feed via two providers). Taking both interleaves the
                // schedule with itself, so the first id to claim it wins.
                const held = owner.get(cid)
                if (held === undefined) owner.set(cid, prog.channel)
                else if (held !== prog.channel) continue

                if (!byCh.has(cid)) byCh.set(cid, [])
                byCh.get(cid).push({
                  s: prog.start,
                  e: prog.stop,
                  t: prog.title,
                  d: prog.desc,
                  c: prog.categories?.[0] || null,
                  i: prog.icon
                })
              }
            }
          })
        } catch (err) {
          // a single missing regional file must not sink the whole guide
          sources['i.mjh.nz'] = { ...(sources['i.mjh.nz'] || {}), warn: err.message }
        }
        // A channel can appear in several regional files; pick by region first
        // rather than keeping whichever worker happened to finish last.
        const region = this._mjhRegion(p)
        for (const [cid, rows] of byCh) {
          const rank = rankOf(region, cid)
          const cur = filled.get(cid)
          if (!cur || rank > cur.rank || (rank === cur.rank && rows.length > cur.rows.length)) {
            filled.set(cid, { rows, region, rank })
          }
        }
        done++
        report(
          `Regional guides — ${done}/${paths.length}`,
          MJH_START + (done / Math.max(1, paths.length)) * (1 - MJH_START)
        )
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker))

    let chCount = 0
    let pCount = 0
    for (const [cid, { rows, rank }] of filled) {
      // A foreign carriage (Fox News via Australian Foxtel) must not clobber a
      // country-matched listing that layer 2 already found. It is still better
      // than nothing when the channel has no guide at all.
      if (rank === 0 && staged.has(cid)) continue
      this._merge(staged, cid, rows, { overwrite: true })
      chCount++
      pCount += rows.length
    }

    sources['i.mjh.nz'] = { channels: chCount, programmes: pCount, kind: 'exact join' }
  }

  /**
   * Bind epgshare's xmltv ids to our channels by name.
   *
   * Matching on name alone is dangerous, and the naive version was actively
   * wrong: it bound US "Fox" to FOX.cz / FOX.HD.cy / Fox+.dk, and — because
   * normName strips every non-ASCII character — collapsed "БНТ1" to "1", so
   * MBC1 pulled listings from Bulgaria, Greece, Israel and Japan. It also let
   * several ids feed ONE channel, concatenating two countries' schedules into
   * one row. Hence three hard rules:
   *
   *   1. a key must be distinctive       — ≥3 chars and not purely numeric
   *   2. the countries must not conflict — Fox.cz may never feed a US channel
   *   3. exactly ONE id per channel      — best match wins, no concatenation
   *
   * Unmatched channels show "No guide data", which is the honest answer.
   */
  _matchEpgshare(chans, idx) {
    const usable = k => k.length >= 3 && !/^\d+$/.test(k)
    // "Fox.News.us" -> US. Suffixes like "us2"/"ca2" name a *source*, not a
    // country, so they stay unknown rather than being used to reject.
    const countryOf = xid => {
      const m = /\.([a-z]{2})$/i.exec(xid)
      return m ? m[1].toUpperCase() : null
    }

    const best = new Map() // channelId -> { xid, score }
    for (const ch of chans) {
      const cc = countryOf(ch.id)
      const fromId = ch.id.replace(/\.[a-z0-9]+$/i, '').replace(/\./g, ' ')

      for (const n of [...ch.names, fromId]) {
        const key = normName(n)
        if (!usable(key)) continue
        const hits = idx.get(key)
        if (!hits) continue

        for (const c of hits) {
          if (cc && c.country && cc !== c.country) continue // rule 2

          let score = 0
          if (ch.names.some(x => x.trim().toLowerCase() === c.name.trim().toLowerCase())) score += 4
          if (cc && c.country && cc === c.country) score += 3
          if (ch.names.some(x => normName(x) === key)) score += 1 // a real display-name, not the id
          if (score < 1) continue // an id-only guess with no country to back it up

          const cur = best.get(c.id)
          if (!cur || score > cur.score || (score === cur.score && ch.id.length < cur.xid.length)) {
            best.set(c.id, { xid: ch.id, score })
          }
        }
      }
    }

    const map = new Map() // xmltvId -> Set(channelId)
    for (const [cid, { xid }] of best) {
      if (!map.has(xid)) map.set(xid, new Set())
      map.get(xid).add(cid) // rule 3: this channel now has exactly one source
    }
    return map
  }

  /** Layer 2: name match against epgshare's aggregate feed (500MB+, streamed). */
  async _grabEpgshare({ inWindow, report, staged, sources }) {
    report('Contacting guide mirror…', 0.01)
    const idx = this.catalog.nameIndex()
    const chans = []
    let map = null // resolved once the whole <channel> block has gone by
    const buckets = new Map()
    let lastAt = 0

    try {
      await fetchXmltv(EPGSHARE_ALL, {
        onBytes: (read, total) => {
          if (read - lastAt < 1 << 21) return // report every 2 MB, not every chunk
          lastAt = read
          const mb = n => (n / (1 << 20)).toFixed(0)
          if (total) {
            report(
              `Downloading guide — ${mb(read)} of ${mb(total)} MB`,
              (read / total) * MJH_START
            )
          } else {
            report(`Downloading guide — ${mb(read)} MB`, null) // no content-length
          }
        },
        onChannel: ch => chans.push(ch),
        onProgramme: prog => {
          // XMLTV declares every channel before the first programme, so by now
          // we can score the whole candidate set rather than take first-hit.
          if (!map) map = this._matchEpgshare(chans, idx)
          const ids = map.get(prog.channel)
          if (!ids || !inWindow(prog)) return
          for (const cid of ids) {
            if (!buckets.has(cid)) buckets.set(cid, [])
            buckets.get(cid).push({
              s: prog.start,
              e: prog.stop,
              t: prog.title,
              d: prog.desc,
              c: prog.categories?.[0] || null,
              i: prog.icon
            })
          }
        }
      })
    } catch (err) {
      sources['epgshare01.online'] = { channels: 0, programmes: 0, error: err.message }
      return
    }

    let pCount = 0
    for (const [cid, rows] of buckets) {
      this._merge(staged, cid, rows, { overwrite: true })
      pCount += rows.length
    }
    sources['epgshare01.online'] = {
      channels: buckets.size,
      programmes: pCount,
      kind: 'name match'
    }
  }

  /** Merge an XMLTV file produced by the local scraper. Highest confidence. */
  async mergeLocal(xmltvPath, idToChannel, label) {
    const fs = require('node:fs')
    const { parseXmltvStream } = require('./xmltv')
    const { Readable } = require('node:stream')
    const now = Date.now()
    const lo = now - WINDOW_BACK_MS
    const hi = now + WINDOW_FWD_MS

    const buckets = new Map()
    const stream = Readable.toWeb(fs.createReadStream(xmltvPath))
    await parseXmltvStream(stream, {
      gzip: xmltvPath.endsWith('.gz'),
      onProgramme: prog => {
        const cid = idToChannel.get(prog.channel)
        if (!cid || !(prog.stop > lo && prog.start < hi)) return
        if (!buckets.has(cid)) buckets.set(cid, [])
        buckets.get(cid).push({
          s: prog.start,
          e: prog.stop,
          t: prog.title,
          d: prog.desc,
          c: prog.categories?.[0] || null,
          i: prog.icon
        })
      }
    })

    let pCount = 0
    for (const [cid, rows] of buckets) {
      this._merge(this.programmes, cid, rows, { overwrite: true })
      pCount += rows.length
    }
    this.sources[label] = { channels: buckets.size, programmes: pCount, kind: 'scraped' }
    this.updatedAt = Date.now()
    await this.store.write('epg', this.serialize())
    return { channels: buckets.size, programmes: pCount }
  }

  /** Programmes for a channel overlapping [from,to]. */
  slice(channelId, from, to) {
    const rows = this.programmes.get(channelId)
    if (!rows) return []
    return rows.filter(p => p.e > from && p.s < to)
  }

  nowNext(channelId, at = Date.now()) {
    const rows = this.programmes.get(channelId)
    if (!rows) return { now: null, next: null }
    const i = rows.findIndex(p => p.e > at)
    if (i === -1) return { now: null, next: null }
    const cur = rows[i].s <= at ? rows[i] : null
    const next = cur ? rows[i + 1] || null : rows[i]
    return { now: cur, next }
  }

  /**
   * Channels showing a programme matching `q` at some point in the guide.
   *
   * This has to live here rather than in the renderer: the renderer only ever
   * holds programmes for the handful of rows scrolled into view, so searching
   * there would only ever find what the user had already looked at. Answering
   * from the full in-memory map is what makes "when is the World Cup on?" work.
   *
   * Returns one hit per channel — the match on now, else the next one to start.
   *
   * Programmes that have already finished are not matches. Ranking them last
   * instead of dropping them looked harmless and wasn't: searching "world cup"
   * on a Sunday returned a wall of FOX affiliates captioned "Sat 3:00 PM" —
   * yesterday's games, on channels whose guide window is now empty, so the grid
   * next to them read "No guide data". You search a guide to find something to
   * watch; a hit you cannot watch is not a hit.
   */
  searchProgrammes(q, { at = Date.now(), limit = 4000 } = {}) {
    const needle = q.trim().toLowerCase()
    if (needle.length < 2) return {}
    const hits = {}
    let n = 0
    for (const [cid, rows] of this.programmes) {
      let best = null
      for (const p of rows) {
        if (p.e <= at) continue // already over
        // Titles only. Searching descriptions too sounded generous but returned
        // rows whose title has nothing to do with the term ("football" -> "Queen
        // Of Katwe"), which just reads as a broken search.
        if (!p.t || !p.t.toLowerCase().includes(needle)) continue
        // on now beats upcoming; within a tier, the soonest wins
        const rank = p.s <= at ? 0 : 1
        if (!best || rank < best.rank || (rank === best.rank && p.s < best.s)) {
          best = { rank, s: p.s, e: p.e, t: p.t }
        }
      }
      if (best) {
        hits[cid] = { s: best.s, e: best.e, t: best.t, live: best.rank === 0 }
        if (++n >= limit) break
      }
    }
    return hits
  }

  stats() {
    return {
      updatedAt: this.updatedAt,
      channels: this.programmes.size,
      forwardHours: Math.round(this.forwardCoverage() / 3600e3),
      sources: this.sources,
      progress: this.progress
    }
  }

  /** Every channel we hold a guide for — the "Guide only" filter needs all of them. */
  ids() {
    return [...this.programmes.keys()]
  }
}

module.exports = { Epg }
