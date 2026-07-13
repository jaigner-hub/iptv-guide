'use strict'
const zlib = require('node:zlib')
const { Readable } = require('node:stream')
const { StringDecoder } = require('node:string_decoder')

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s
  return s.replace(/&(?:#(x?)([0-9a-fA-F]+)|([a-zA-Z]+));/g, (m, hex, num, name) => {
    if (num) return String.fromCodePoint(parseInt(num, hex ? 16 : 10))
    return ENTITIES[name] ?? m
  })
}

/**
 * XMLTV timestamps: "20260710000000 +0000" (offset optional). Returns epoch ms.
 */
function parseTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*([+-])(\d{2})(\d{2}))?/.exec(String(s).trim())
  if (!m) return NaN
  const [, Y, Mo, D, H, Mi, S, sign, oh, om] = m
  let t = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +(S || 0))
  if (sign) {
    const off = (+oh * 60 + +om) * 60000
    t += sign === '+' ? -off : off // convert local-with-offset to UTC
  }
  return t
}

const attr = (tag, name) => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag)
  return m ? decodeEntities(m[1]) : null
}
const textOf = (block, tag) => {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block)
  return m ? decodeEntities(m[1].trim()) : null
}
const allText = (block, tag) =>
  [...block.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].map(m =>
    decodeEntities(m[1].trim())
  )

/**
 * Streams an XMLTV document, invoking callbacks per element. Never materialises
 * the whole document — required, since some feeds exceed Node's max string length.
 *
 * onChannel({ id, names[], icon })
 * onProgramme({ channel, start, stop, title, sub, desc, categories[], icon, episode })
 * Return `false` from onProgramme's owner via `wanted` to skip cheap.
 */
async function parseXmltvStream(webStream, { onChannel, onProgramme, gzip = true } = {}) {
  const node = Readable.fromWeb(webStream)
  const src = gzip ? node.pipe(zlib.createGunzip()) : node
  const decoder = new StringDecoder('utf8')

  let buf = ''
  const TAGS = [
    { open: '<channel ', close: '</channel>', kind: 'channel' },
    { open: '<programme ', close: '</programme>', kind: 'programme' }
  ]

  const flush = final => {
    for (;;) {
      // find the earliest opening tag of either kind
      let best = null
      for (const t of TAGS) {
        const i = buf.indexOf(t.open)
        if (i !== -1 && (!best || i < best.i)) best = { i, t }
      }
      if (!best) {
        // no element start in the buffer; keep only a small tail in case a tag
        // is split across chunk boundaries
        if (!final && buf.length > 64) buf = buf.slice(-64)
        return
      }
      const end = buf.indexOf(best.t.close, best.i)
      if (end === -1) {
        if (best.i > 0) buf = buf.slice(best.i) // drop consumed prefix, keep partial element
        return // need more data
      }
      const block = buf.slice(best.i, end + best.t.close.length)
      buf = buf.slice(end + best.t.close.length)

      if (best.t.kind === 'channel' && onChannel) {
        const head = block.slice(0, block.indexOf('>') + 1)
        const id = attr(head, 'id')
        if (id) {
          onChannel({
            id,
            names: allText(block, 'display-name'),
            icon: attr((block.match(/<icon[^>]*>/) || [''])[0], 'src')
          })
        }
      } else if (best.t.kind === 'programme' && onProgramme) {
        const head = block.slice(0, block.indexOf('>') + 1)
        const channel = attr(head, 'channel')
        if (channel) {
          onProgramme({
            channel,
            start: parseTime(attr(head, 'start')),
            stop: parseTime(attr(head, 'stop')),
            title: textOf(block, 'title'),
            sub: textOf(block, 'sub-title'),
            desc: textOf(block, 'desc'),
            categories: allText(block, 'category'),
            icon: attr((block.match(/<icon[^>]*>/) || [''])[0], 'src'),
            episode: textOf(block, 'episode-num')
          })
        }
      }
    }
  }

  for await (const chunk of src) {
    buf += decoder.write(chunk)
    if (buf.length > 8 * 1024 * 1024) flush(false) // bound memory on pathological input
    else flush(false)
  }
  buf += decoder.end()
  flush(true)
}

/**
 * handlers.onBytes(read, total) fires as compressed bytes land, so a caller can
 * show real download progress. `total` is 0 when the server sends no
 * content-length (then the caller should show an indeterminate bar, not a lie).
 */
async function fetchXmltv(url, handlers = {}) {
  const { onBytes, ...rest } = handlers
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  const gz = url.endsWith('.gz') || (res.headers.get('content-type') || '').includes('gzip')

  let body = res.body
  if (onBytes) {
    const total = Number(res.headers.get('content-length')) || 0
    let read = 0
    body = body.pipeThrough(
      new TransformStream({
        transform(chunk, ctrl) {
          read += chunk.byteLength
          onBytes(read, total)
          ctrl.enqueue(chunk)
        }
      })
    )
  }
  await parseXmltvStream(body, { ...rest, gzip: gz })
}

module.exports = { parseXmltvStream, fetchXmltv, parseTime, decodeEntities }
