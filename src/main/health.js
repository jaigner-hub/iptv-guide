'use strict'
const fs = require('node:fs')
const path = require('node:path')

/**
 * Which channels have never once tuned.
 *
 * About 1 in 4 iptv-org streams are geo-blocked or only broadcast part-time, and
 * a channel whose every source is dead looks exactly like a working one until you
 * click it and sit through the failover. This records the outcome so the guide
 * can hide the hopeless ones.
 *
 * Two rules keep it from hiding channels that actually work:
 *
 *  - A success is permanent. "It works and it's having a bad evening" is not the
 *    same as "this has never played", and only the second is worth hiding. Once
 *    `ok` is set nothing can mark the channel dead again.
 *  - A failure counts at most once per app session. One bad network evening would
 *    otherwise bury every channel the user touched during it.
 *
 * Keyed by channel id (`10Bold.au`), never by sid. A sid is `channelId|index`
 * where the index is assigned *after* sorting (catalog.js) and the catalog is
 * re-fetched every 24 h — so sids silently re-point at different streams, while
 * channel ids are stable.
 *
 * This is deliberately not in settings.json: that file is meant to be opened and
 * edited by hand, and a few hundred health records would bury the handful of
 * settings a person actually wants to change.
 */
const DEAD_FAILS = 2

class Health {
  /** @param session opaque id for this app run; failures dedupe against it. */
  constructor(file, session) {
    this.file = file
    this.session = session
    fs.mkdirSync(path.dirname(file), { recursive: true })
    let data = {}
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      data = {}
    }
    this.data = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  }

  _save() {
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    fs.renameSync(tmp, this.file) // never leave a half-written file behind
  }

  /** The channel delivered video. Permanent — it can never be marked dead after this. */
  ok(id) {
    if (!id || this.data[id]?.ok) return this.data
    this.data[id] = { ok: 1, at: Date.now() }
    this._save()
    return this.data
  }

  /** Every source for the channel was tried and none delivered video. */
  fail(id) {
    if (!id) return this.data
    const rec = this.data[id] || {}
    if (rec.ok) return this.data // known good; a bad night doesn't undo that
    if (rec.session === this.session) return this.data // already counted this run
    this.data[id] = { fails: (rec.fails || 0) + 1, session: this.session, at: Date.now() }
    this._save()
    return this.data
  }

  isDead(id) {
    const rec = this.data[id]
    return !!rec && !rec.ok && (rec.fails || 0) >= DEAD_FAILS
  }

  deadIds() {
    return Object.keys(this.data).filter(id => this.isDead(id))
  }

  reset() {
    this.data = {}
    this._save()
    return this.data
  }
}

module.exports = { Health, DEAD_FAILS }
