'use strict'
const http = require('node:http')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { URL } = require('node:url')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
}

const b64u = {
  enc: s => Buffer.from(s, 'utf8').toString('base64url'),
  dec: s => Buffer.from(s, 'base64url').toString('utf8')
}

// A browser cannot set User-Agent or Referer from JS, and ~1,100 iptv-org
// streams 403 without them. Everything therefore goes through this proxy,
// which also sidesteps CORS on the CDNs that don't send permissive headers.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// Tests that don't care about channel health leave it out rather than writing
// records into .selftest just by failing a stream over.
const NO_HEALTH = { ok: () => {}, fail: () => {}, deadIds: () => [], reset: () => {} }

function createServer({
  catalog,
  epg,
  settings,
  health = NO_HEALTH,
  scraper,
  rendererDir,
  onStatus,
  bootState = () => ({ ready: true }),
  onRetry = () => {}
}) {
  const proxyPathFor = (sid, url) => `/p/${encodeURIComponent(sid)}/${b64u.enc(url)}`

  /** Rewrite every URI in an HLS manifest to point back through this proxy. */
  function rewriteManifest(text, baseUrl, sid) {
    const abs = u => {
      try {
        return new URL(u, baseUrl).toString()
      } catch {
        return null
      }
    }
    const via = u => {
      const a = abs(u)
      return a ? proxyPathFor(sid, a) : u
    }

    return text
      .split(/\r?\n/)
      .map(line => {
        if (!line) return line
        if (line.startsWith('#')) {
          // URI="..." appears in EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, EXT-X-I-FRAME-…
          return line.replace(/URI="([^"]+)"/g, (m, u) => `URI="${via(u)}"`)
        }
        return via(line) // segment or variant playlist
      })
      .join('\n')
  }

  const send = (res, code, body, headers = {}) => {
    res.writeHead(code, { 'cache-control': 'no-store', ...headers })
    res.end(body)
  }
  const sendJson = (res, obj, code = 200) =>
    send(res, code, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' })

  async function handleProxy(req, res, sid, encoded) {
    let target
    try {
      target = b64u.dec(encoded)
    } catch {
      return send(res, 400, 'bad url')
    }
    if (!/^https?:\/\//i.test(target)) return send(res, 400, 'bad scheme')

    const stream = catalog.streamBySid?.get(sid)
    const headers = {
      'user-agent': stream?.userAgent || BROWSER_UA,
      accept: '*/*'
    }
    if (stream?.referrer) {
      headers.referer = stream.referrer
      try {
        headers.origin = new URL(stream.referrer).origin
      } catch {}
    }
    // pass Range through so seeking / byte-range segments work
    if (req.headers.range) headers.range = req.headers.range

    let upstream
    try {
      upstream = await fetch(target, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(20000)
      })
    } catch (err) {
      return send(res, 502, `upstream fetch failed: ${err.message}`)
    }

    if (!upstream.ok && upstream.status !== 206) {
      return send(res, upstream.status, `upstream ${upstream.status}`)
    }

    const ctype = upstream.headers.get('content-type') || ''
    const finalUrl = upstream.url || target
    const isManifest =
      /mpegurl/i.test(ctype) || /\.m3u8(\?|$)/i.test(finalUrl.split('#')[0])

    if (isManifest) {
      const text = await upstream.text()
      const body = rewriteManifest(text, finalUrl, sid)
      return send(res, 200, body, {
        'content-type': 'application/vnd.apple.mpegurl',
        'access-control-allow-origin': '*'
      })
    }

    // stream media through untouched
    const out = {
      'content-type': ctype || 'application/octet-stream',
      'access-control-allow-origin': '*'
    }
    for (const h of ['content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h)
      if (v) out[h] = v
    }
    res.writeHead(upstream.status, out)

    if (!upstream.body) return res.end()
    const { Readable } = require('node:stream')
    Readable.fromWeb(upstream.body)
      .on('error', () => res.destroy())
      .pipe(res)
      .on('error', () => {})
  }

  /** Proxy remote logos: many are on imgur, which hotlink-blocks in some regions. */
  async function handleLogo(req, res, encoded) {
    let target
    try {
      target = b64u.dec(encoded)
    } catch {
      return send(res, 400, 'bad url')
    }
    try {
      const up = await fetch(target, {
        headers: { 'user-agent': BROWSER_UA },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000)
      })
      if (!up.ok) return send(res, 404, '')
      const buf = Buffer.from(await up.arrayBuffer())
      return send(res, 200, buf, {
        'content-type': up.headers.get('content-type') || 'image/png',
        'cache-control': 'public, max-age=604800'
      })
    } catch {
      return send(res, 404, '')
    }
  }

  async function handleStatic(req, res, pathname) {
    const rel = pathname === '/' ? '/index.html' : pathname
    const file = path.join(rendererDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''))
    if (!file.startsWith(rendererDir)) return send(res, 403, 'forbidden')
    try {
      const buf = await fsp.readFile(file)
      return send(res, 200, buf, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream'
      })
    } catch {
      return send(res, 404, 'not found')
    }
  }

  const server = http.createServer(async (req, res) => {
    let u
    try {
      u = new URL(req.url, 'http://localhost')
    } catch {
      return send(res, 400, 'bad request')
    }
    const p = u.pathname

    try {
      // ---- stream proxy: /p/:sid/:base64url ----
      const mProxy = /^\/p\/([^/]+)\/(.+)$/.exec(p)
      if (mProxy) return handleProxy(req, res, decodeURIComponent(mProxy[1]), mProxy[2])

      const mLogo = /^\/logo\/(.+)$/.exec(p)
      if (mLogo) return handleLogo(req, res, mLogo[1])

      // ---- api ----
      if (p === '/api/bootstrap') {
        // The window opens before the catalog is downloaded, so say so rather
        // than throwing; the renderer shows progress and, on failure, a retry.
        const b = bootState()
        if (!b.ready) {
          return sendJson(res, { ready: false, status: b.status || '', error: b.error || null })
        }
        const meta = catalog.meta()
        return sendJson(res, {
          ready: true,
          channels: catalog.channels.map(c => ({
            ...c,
            logo: c.logo ? `/logo/${b64u.enc(c.logo)}` : null,
            streams: c.streams.map(s => ({
              sid: s.sid,
              quality: s.quality,
              label: s.label,
              feed: s.feed,
              needsHeaders: !!(s.userAgent || s.referrer),
              src: proxyPathFor(s.sid, s.url)
            }))
          })),
          categories: [...meta.categories].map(([id, name]) => ({ id, name })),
          countries: [...meta.countries].map(([code, c]) => ({
            code,
            name: c.name,
            flag: c.flag
          })),
          settings: settings.data,
          epg: epg.stats(),
          // every channel that has a guide, not just the ones the renderer has
          // lazily fetched — the "Guide only" filter must see all of them
          epgIds: epg.ids(),
          // likewise: channels that have never tuned, for the "Hide dead" filter
          dead: health.deadIds()
        })
      }

      if (p === '/api/epg/ids') return sendJson(res, epg.ids())

      // Searching programme titles must happen here, over the whole guide — the
      // renderer only holds rows for channels currently on screen.
      if (p === '/api/epg/search') {
        return sendJson(res, epg.searchProgrammes(u.searchParams.get('q') || ''))
      }

      if (p === '/api/epg') {
        const from = +u.searchParams.get('from') || Date.now()
        const to = +u.searchParams.get('to') || from + 6 * 3600e3
        const ids = (u.searchParams.get('ids') || '').split(',').filter(Boolean)
        const out = {}
        for (const id of ids) {
          const rows = epg.slice(id, from, to)
          if (rows.length) out[id] = rows
        }
        return sendJson(res, out)
      }

      if (p === '/api/settings' && req.method === 'POST') {
        const body = await readBody(req)
        return sendJson(res, settings.set(JSON.parse(body || '{}')))
      }

      // The renderer reports what it saw; the session-dedupe and the "a success
      // is permanent" rule live here, in one place — see health.js.
      const mHealth = /^\/api\/health\/(ok|fail|reset)$/.exec(p)
      if (mHealth && req.method === 'POST') {
        const kind = mHealth[1]
        if (kind === 'reset') health.reset()
        else health[kind](JSON.parse((await readBody(req)) || '{}').id)
        return sendJson(res, { dead: health.deadIds() })
      }

      if (p === '/api/epg/refresh' && req.method === 'POST') {
        onStatus?.('Refreshing guide…')
        epg.refresh({ onProgress: onStatus }).catch(e => onStatus?.(`Guide error: ${e.message}`))
        return sendJson(res, { started: true })
      }

      if (p === '/api/epg/status') return sendJson(res, epg.stats())

      if (p === '/api/retry' && req.method === 'POST') {
        onRetry()
        return sendJson(res, { started: true })
      }

      // ---- scraper ----
      if (p === '/api/scraper/sites') return sendJson(res, scraper.sites())
      if (p === '/api/scraper/run' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        scraper.run(body).catch(e => onStatus?.(`Scrape failed: ${e.message}`))
        return sendJson(res, { started: true })
      }
      if (p === '/api/scraper/status') return sendJson(res, scraper.status())

      return handleStatic(req, res, p)
    } catch (err) {
      return send(res, 500, String(err && err.message))
    }
  })

  return { server, proxyPathFor }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = ''
    req.on('data', c => {
      s += c
      if (s.length > 1e6) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(s))
    req.on('error', reject)
  })
}

module.exports = { createServer, b64u }
