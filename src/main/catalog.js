'use strict'

const API = 'https://iptv-org.github.io/api'
const ENDPOINTS = ['channels', 'feeds', 'streams', 'logos', 'categories', 'countries', 'guides', 'blocklist']
const REFRESH_MS = 24 * 60 * 60 * 1000

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * A cold start downloads ~6MB across 8 endpoints. Without a timeout a hung
 * socket hangs the app forever, and without retries a single blip on a hotel
 * or office network takes the whole launch down with it.
 */
const json = async (name, tries = 3) => {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${API}/${name}.json`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(30000)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      last = err
      if (i < tries - 1) await sleep(600 * 2 ** i)
    }
  }
  throw new Error(`${name}.json: ${last.message}`)
}

/**
 * Normalise a channel/programme name for fuzzy matching against EPG sources.
 * Drops quality/feed markers that differ arbitrarily between providers.
 */
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(hd|sd|fhd|uhd|4k|hdtv|dt|east|west|east feed|west feed)\b/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z0-9]/g, '')
}

class Catalog {
  constructor(store) {
    this.store = store
    this.raw = null
    this.channels = [] // working set, enriched
    this.byId = new Map()
  }

  async load({ force = false, onProgress = () => {} } = {}) {
    let raw = force ? null : await this.store.read('catalog', REFRESH_MS)
    if (!raw) {
      onProgress('Downloading channel catalog…')
      let done = 0
      try {
        const parts = await Promise.all(
          ENDPOINTS.map(name =>
            json(name).then(p => {
              onProgress(`Downloading channel catalog… ${++done}/${ENDPOINTS.length}`)
              return p
            })
          )
        )
        raw = Object.fromEntries(ENDPOINTS.map((k, i) => [k, parts[i]]))
        await this.store.write('catalog', raw)
      } catch (err) {
        // An expired catalog beats no app at all — channels change slowly.
        const stale = await this.store.read('catalog')
        if (!stale) throw err
        onProgress('Offline — using the last downloaded catalog')
        raw = stale
      }
    }
    this.raw = raw
    this.build()
    return this.channels
  }

  build() {
    const { channels, feeds, streams, logos, blocklist } = this.raw

    const blocked = new Set(blocklist.map(b => b.channel))

    const feedsByCh = new Map()
    for (const f of feeds) {
      if (!feedsByCh.has(f.channel)) feedsByCh.set(f.channel, [])
      feedsByCh.get(f.channel).push(f)
    }

    // Prefer an in-use logo; fall back to any logo for the channel.
    const logoByCh = new Map()
    for (const l of logos) {
      if (!l.url) continue
      const cur = logoByCh.get(l.channel)
      if (!cur || (l.in_use && !cur.in_use)) logoByCh.set(l.channel, l)
    }

    // Streams grouped per channel. Streams with channel:null are unidentified —
    // they have no name, logo or guide, so they can't appear as a guide row.
    const streamsByCh = new Map()
    for (const s of streams) {
      if (!s.channel || !s.url) continue
      if (!streamsByCh.has(s.channel)) streamsByCh.set(s.channel, [])
      streamsByCh.get(s.channel).push(s)
    }

    const rank = q => {
      const m = /(\d+)p/.exec(q || '')
      return m ? +m[1] : 0
    }

    // `label` is free-text and dirty ("Not 24/7] [Geo-blocked", "_Geo-blocked_"),
    // so match loosely. Streams flagged this way often stall rather than error,
    // so it's worth trying a clean source first even at lower quality.
    const penalty = label => {
      const l = (label || '').toLowerCase()
      let p = 0
      if (l.includes('geo')) p += 2
      if (l.includes('24/7') || l.includes('not 24')) p += 1
      return p
    }

    this.channels = []
    for (const c of channels) {
      if (blocked.has(c.id) || c.closed) continue
      const chStreams = streamsByCh.get(c.id)
      if (!chStreams || !chStreams.length) continue

      const chFeeds = feedsByCh.get(c.id) || []
      const languages = [...new Set(chFeeds.flatMap(f => f.languages || []))]

      const sorted = [...chStreams].sort(
        (a, b) => penalty(a.label) - penalty(b.label) || rank(b.quality) - rank(a.quality)
      )
      const entry = {
        id: c.id,
        name: c.name,
        altNames: c.alt_names || [],
        country: c.country,
        categories: c.categories || [],
        languages,
        nsfw: !!c.is_nsfw,
        network: c.network,
        website: c.website,
        logo: logoByCh.get(c.id)?.url || null,
        streams: sorted.map((s, i) => ({
          sid: `${c.id}|${i}`,
          url: s.url,
          quality: s.quality,
          label: s.label,
          feed: s.feed,
          userAgent: s.user_agent || null,
          referrer: s.referrer || null
        }))
      }
      this.channels.push(entry)
      this.byId.set(c.id, entry)
    }

    this.channels.sort((a, b) => a.name.localeCompare(b.name))

    this.streamBySid = new Map()
    for (const c of this.channels) for (const s of c.streams) this.streamBySid.set(s.sid, s)

    return this.channels
  }

  /** Default scope: US-country or English-language channels that have a stream. */
  isDefaultScope(c) {
    return c.country === 'US' || c.languages.includes('eng')
  }

  /** Name index for fuzzy EPG matching: normalised name -> [channel] */
  nameIndex(subset = this.channels) {
    const idx = new Map()
    for (const c of subset) {
      for (const n of [c.name, ...c.altNames]) {
        const k = normName(n)
        if (!k) continue
        if (!idx.has(k)) idx.set(k, [])
        idx.get(k).push(c)
      }
    }
    return idx
  }

  meta() {
    const cats = new Map(this.raw.categories.map(c => [c.id, c.name]))
    const countries = new Map(this.raw.countries.map(c => [c.code, c]))
    return { categories: cats, countries }
  }
}

module.exports = { Catalog, normName, API }
