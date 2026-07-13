'use strict'
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const zlib = require('node:zlib')

/**
 * Disk cache under the app's userData dir. Values are gzipped JSON — the EPG
 * payload is tens of MB and gzip cuts it by ~10x for a few ms of CPU.
 */
class Store {
  constructor(dir) {
    this.dir = dir
    fs.mkdirSync(dir, { recursive: true })
  }

  _file(key) {
    return path.join(this.dir, `${key}.json.gz`)
  }

  async read(key, maxAgeMs = Infinity) {
    const file = this._file(key)
    try {
      const stat = await fsp.stat(file)
      if (Date.now() - stat.mtimeMs > maxAgeMs) return null
      const buf = await fsp.readFile(file)
      return JSON.parse(zlib.gunzipSync(buf).toString('utf8'))
    } catch {
      return null
    }
  }

  async write(key, value) {
    const file = this._file(key)
    const tmp = `${file}.tmp`
    const buf = zlib.gzipSync(Buffer.from(JSON.stringify(value), 'utf8'))
    await fsp.writeFile(tmp, buf)
    await fsp.rename(tmp, file) // atomic-ish: never leave a half-written cache
  }

  async age(key) {
    try {
      return Date.now() - (await fsp.stat(this._file(key))).mtimeMs
    } catch {
      return null
    }
  }
}

/** Small plain-JSON store for settings/favorites — small, read often, human-editable. */
class Settings {
  constructor(file, defaults) {
    this.file = file
    fs.mkdirSync(path.dirname(file), { recursive: true })
    let data = {}
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      data = {}
    }
    this.data = { ...defaults, ...data }
  }

  get(key) {
    return this.data[key]
  }

  set(patch) {
    Object.assign(this.data, patch)
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
    return this.data
  }
}

module.exports = { Store, Settings }
