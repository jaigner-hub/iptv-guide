const PX_PER_MIN = 5
const ROW_H = 56
const WINDOW_H = 24 // hours shown on the timeline
const BACK_MIN = 30 // start the timeline slightly in the past

const $ = s => document.querySelector(s)
const el = (tag, cls, txt) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (txt != null) n.textContent = txt
  return n
}

const state = {
  channels: [],
  filtered: [],
  categories: [],
  countries: [],
  settings: {},
  favorites: new Set(),
  epg: new Map(), // channelId -> programmes[] | null (null = fetched, none)
  epgIds: new Set(), // every channel the server holds a guide for
  progHits: new Map(), // channelId -> {t,s,e,live} for the current search term
  pending: new Set(),
  playing: null,
  t0: 0,
  t1: 0
}

const grid = $('#grid')
const gridInner = $('#grid-inner')
const chancol = $('#chancol')
const chancolInner = $('#chancol-inner')
const timebar = $('#timebar')
const timebarInner = $('#timebar-inner')

/**
 * Status messages arrive either as plain strings or as {text, pct} while the
 * guide downloads. pct === null means "working, but the size is unknown" —
 * show an indeterminate bar rather than inventing a number.
 */
function setStatus(m) {
  const text = typeof m === 'string' ? m : m?.text || ''
  const pct = typeof m === 'string' ? undefined : m?.pct
  $('#status').textContent = text
  if (pct !== undefined) setProgress(text, pct, pct !== 1)
}

function setProgress(text, pct, active) {
  for (const wrap of [$('#progress'), $('#epg-progress')]) {
    wrap.classList.toggle('hidden', !active)
    wrap.classList.toggle('indeterminate', active && pct == null)
    wrap.querySelector('.bar').style.width = pct == null ? '' : `${Math.round(pct * 100)}%`
  }
  const label = $('#epg-progress-text')
  label.textContent = text || ''
  label.classList.toggle('hidden', !active)
}
const minsToPx = m => m * PX_PER_MIN
const timeToPx = t => minsToPx((t - state.t0) / 60000)
const fmtTime = t =>
  new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

// A search hit can be days away, so a bare clock time would be ambiguous.
const whenLabel = t => {
  const d = new Date(t)
  const days = Math.round((d.setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400e3)
  const day = days === 0 ? '' : days === 1 ? 'Tomorrow ' : `${DAYS[new Date(t).getDay()]} `
  return day + fmtTime(t)
}
const fullWhen = t =>
  new Date(t).toLocaleString([], {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit'
  })
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/* ─────────────────────────── boot ─────────────────────────── */

/**
 * The window is up before the catalog has downloaded, so the first thing to do
 * is wait for the backend — reporting what it's doing, and what went wrong if
 * it can't. Startup used to fail silently behind a blank window.
 */
async function waitForBackend() {
  const overlay = $('#startup')
  const msg = $('#startup-msg')
  $('#startup-retry').onclick = async () => {
    $('#startup-retry').disabled = true
    msg.textContent = 'Trying again…'
    await fetch('/api/retry', { method: 'POST' })
    setTimeout(() => ($('#startup-retry').disabled = false), 2000)
  }

  for (;;) {
    let d
    try {
      d = await (await fetch('/api/bootstrap')).json()
    } catch {
      d = { ready: false, status: 'Starting…' }
    }
    if (d.ready) {
      overlay.classList.add('hidden')
      return d
    }
    if (d.error) {
      overlay.classList.remove('hidden')
      msg.textContent = d.error
    } else {
      setStatus(d.status || 'Starting…')
    }
    await new Promise(r => setTimeout(r, 600))
  }
}

async function boot() {
  const now = Date.now()
  const slot = 30 * 60000
  state.t0 = Math.floor((now - BACK_MIN * 60000) / slot) * slot
  state.t1 = state.t0 + WINDOW_H * 3600e3

  window.native?.onStatus(setStatus) // before the wait, so its progress shows
  const data = await waitForBackend()
  state.channels = data.channels
  state.categories = data.categories
  state.countries = data.countries
  state.settings = data.settings
  state.favorites = new Set(data.settings.favorites || [])
  state.epgIds = new Set(data.epgIds || [])

  buildFilters()
  buildTimebar()
  applyFilters()
  applyLayout()
  renderEpgStats(data.epg)

  gridInner.style.width = `${timeToPx(state.t1)}px`
  timebarInner.style.width = `${timeToPx(state.t1)}px`

  scrollToNow()
  tickNowLine()
  setInterval(tickNowLine, 30000)

  // Deliberately do NOT reopen the player for the last channel: restoring it
  // without playing just parks a large black box over the guide.

  setStatus(`${state.channels.length} channels · guide for ${data.epg.channels || 0}`)
  pollEpg()
}

/* ─────────────────────────── filters ──────────────────────── */

function buildFilters() {
  const fc = $('#f-country')
  fc.append(new Option('All countries', ''))
  const present = new Set(state.channels.map(c => c.country))
  for (const c of state.countries) {
    if (!present.has(c.code)) continue
    fc.append(new Option(`${c.flag || ''} ${c.name}`.trim(), c.code))
  }
  fc.value = state.settings.country ?? 'US'

  const fk = $('#f-category')
  fk.append(new Option('All categories', ''))
  for (const c of state.categories) fk.append(new Option(c.name, c.id))
  fk.value = state.settings.category ?? ''

  $('#f-fav').classList.toggle('on', !!state.settings.favOnly)
  $('#f-epg').classList.toggle('on', !!state.settings.epgOnly)

  const rerun = () => {
    saveSettings({
      country: fc.value,
      category: fk.value,
      favOnly: $('#f-fav').classList.contains('on'),
      epgOnly: $('#f-epg').classList.contains('on')
    })
    applyFilters()
  }

  fc.onchange = rerun
  fk.onchange = rerun
  $('#f-fav').onclick = e => {
    e.currentTarget.classList.toggle('on')
    rerun()
  }
  $('#f-epg').onclick = e => {
    e.currentTarget.classList.toggle('on')
    rerun()
  }

  let deb
  $('#search').oninput = () => {
    clearTimeout(deb)
    deb = setTimeout(searchNow, 200)
  }

  $('#btn-now').onclick = scrollToNow
  $('#btn-settings').onclick = openSettings
  $('#btn-close-modal').onclick = () => $('#modal').classList.add('hidden')
}

// The search box matches channel names *and* what's on them. Programme titles
// live on the server (see /api/epg/search), so the term has to round-trip before
// we can filter — `seq` drops the answer if the user has typed on since.
let searchSeq = 0
async function searchNow() {
  const q = $('#search').value.trim()
  const seq = ++searchSeq
  if (q.length < 2) {
    state.progHits = new Map()
    return applyFilters()
  }
  applyFilters() // show the name matches immediately; don't wait on the network
  try {
    const hits = await (await fetch(`/api/epg/search?q=${encodeURIComponent(q)}`)).json()
    if (seq !== searchSeq) return
    state.progHits = new Map(Object.entries(hits))
    applyFilters()
  } catch {
    /* keep the name-only results */
  }
}

const matchesName = (c, q) => (c.name + ' ' + c.altNames.join(' ')).toLowerCase().includes(q)

function applyFilters() {
  const q = $('#search').value.trim().toLowerCase()
  const country = $('#f-country').value
  const cat = $('#f-category').value
  const favOnly = $('#f-fav').classList.contains('on')
  const epgOnly = $('#f-epg').classList.contains('on')
  const scopeAll = state.settings.scope === 'all'
  const hideNsfw = state.settings.hideNsfw !== false

  state.filtered = state.channels.filter(c => {
    if (hideNsfw && c.nsfw) return false
    if (!scopeAll && !(c.country === 'US' || c.languages.includes('eng'))) return false
    if (country && c.country !== country) return false
    if (cat && !c.categories.includes(cat)) return false
    if (favOnly && !state.favorites.has(c.id)) return false
    if (epgOnly && !hasEpg(c.id)) return false
    if (q && !matchesName(c, q) && !state.progHits.has(c.id)) return false
    return true
  })

  // favourites first, then channels whose *name* matched (a search for "cnn"
  // should not bury CNN under everything merely mentioning it), then alphabetical
  state.filtered.sort((a, b) => {
    const fa = state.favorites.has(a.id) ? 0 : 1
    const fb = state.favorites.has(b.id) ? 0 : 1
    const na = q && matchesName(a, q) ? 0 : 1
    const nb = q && matchesName(b, q) ? 0 : 1
    return fa - fb || na - nb || a.name.localeCompare(b.name)
  })

  $('#chan-count').textContent = `${state.filtered.length} ch`
  const h = state.filtered.length * ROW_H
  gridInner.style.height = `${h}px`
  chancolInner.style.height = `${h}px`
  render()
}

// Answered from the server's full id set, NOT from state.epg — that map is only
// populated for rows scrolled into view, so filtering on it hid every channel
// the user hadn't already scrolled past.
const hasEpg = id => state.epgIds.has(id)

/* ─────────────────────────── timebar ──────────────────────── */

function buildTimebar() {
  timebarInner.innerHTML = ''
  for (let t = state.t0; t < state.t1; t += 30 * 60000) {
    const d = new Date(t)
    const isHour = d.getMinutes() === 0
    const tick = el('div', `tick${isHour ? ' hour' : ''}`)
    tick.style.left = `${timeToPx(t)}px`
    tick.style.width = `${minsToPx(30)}px`
    tick.textContent = isHour
      ? d.toLocaleTimeString([], { hour: 'numeric' }) +
        (d.getHours() === 0 ? ` · ${d.toLocaleDateString([], { weekday: 'short' })}` : '')
      : ':30'
    timebarInner.append(tick)
  }
}

function tickNowLine() {
  const x = timeToPx(Date.now())
  $('#nowline').style.left = `${x}px`
  render() // live-programme highlighting drifts otherwise
}

function scrollToNow() {
  grid.scrollLeft = Math.max(0, timeToPx(Date.now()) - 140)
}

function scrollToTime(t) {
  grid.scrollTo({ left: Math.max(0, timeToPx(t) - 140), behavior: 'smooth' })
}

/* ─────────────────────── virtualised render ───────────────── */

let raf = 0
const schedule = () => {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    render()
  })
}

grid.addEventListener('scroll', () => {
  chancol.scrollTop = grid.scrollTop
  timebar.scrollLeft = grid.scrollLeft
  schedule()
})
window.addEventListener('resize', schedule)

function render() {
  const top = grid.scrollTop
  const vh = grid.clientHeight
  const first = Math.max(0, Math.floor(top / ROW_H) - 3)
  const last = Math.min(state.filtered.length, Math.ceil((top + vh) / ROW_H) + 3)

  const left = grid.scrollLeft
  const vw = grid.clientWidth
  const tFrom = state.t0 + (left / PX_PER_MIN) * 60000
  const tTo = state.t0 + ((left + vw) / PX_PER_MIN) * 60000

  renderChannels(first, last)
  renderProgrammes(first, last, tFrom, tTo)
  pinTitles(left)
  fetchEpgFor(state.filtered.slice(first, last))
}

/**
 * A programme that began before the visible window starts off-screen to the left,
 * so its title scrolls out of the viewport and only the tail is visible, jammed
 * against the channel column. Slide the label back into view — the standard EPG
 * behaviour — capped so it never runs past the end of its own block.
 */
function pinTitles(scrollLeft) {
  for (const box of gridInner.children) {
    if (!box.dataset.ch) continue
    const l = +box.dataset.left
    const w = +box.dataset.w
    const pin = box.firstChild
    if (!pin) continue
    const offset = Math.max(0, Math.min(scrollLeft - l, w - 108))
    pin.style.transform = offset > 0 ? `translateX(${offset}px)` : ''
  }
}

function renderChannels(first, last) {
  const want = new Map()
  for (let i = first; i < last; i++) want.set(state.filtered[i].id, i)

  // A reused row must be rebuilt when its position or state changes. Reusing it
  // blindly kept the old `top`, so a re-sort (favouriting floats a channel up)
  // stacked two channels on the same line, and left stale stars behind.
  const sigOf = (id, i) =>
    `${i}|${state.favorites.has(id) ? 1 : 0}|${state.playing?.id === id ? 1 : 0}` +
    `|${state.progHits.get(id)?.t || ''}`

  for (const node of [...chancolInner.children]) {
    const id = node.dataset.id
    const i = want.get(id)
    if (i === undefined || node.dataset.sig !== sigOf(id, i)) node.remove()
    else want.delete(id)
  }

  for (const [id, i] of want) {
    const c = state.filtered[i]
    const row = el('div', 'chan')
    row.dataset.id = id
    row.dataset.sig = sigOf(id, i)
    row.style.top = `${i * ROW_H}px`
    if (state.favorites.has(id)) row.classList.add('fav')
    if (state.playing?.id === id) row.classList.add('playing')

    const img = el('img')
    img.src = c.logo || ''
    img.loading = 'lazy'
    img.onerror = () => (img.style.visibility = 'hidden')

    const n = el('div', 'n')
    n.append(el('div', 'nm', c.name))

    // If this channel is only in the list because of what's *on* it, say so —
    // otherwise a search for "world cup" returns a wall of unexplained channels.
    const hit = state.progHits.get(id)
    if (hit) {
      const sub = el('div', 'sub hit')
      sub.append(el('span', 'hit-when', hit.live ? 'NOW' : whenLabel(hit.s)))
      sub.append(el('span', 'hit-title', hit.t))
      // The guide runs further forward (~81h) than the timeline shows (24h), so a
      // hit can be real but unreachable. Say when it is; only offer the jump if
      // the grid can actually scroll there.
      const reachable = hit.s < state.t1
      sub.title = `${hit.t} — ${fullWhen(hit.s)}${reachable ? '\nClick to jump to it in the guide' : ''}`
      sub.dataset.start = hit.s
      if (reachable) {
        sub.classList.add('jump')
        sub.onclick = e => {
          e.stopPropagation() // clicking the row plays the channel; this just navigates
          scrollToTime(hit.s)
        }
      }
      n.append(sub)
    } else {
      n.append(el('div', 'sub', [c.country, c.categories[0]].filter(Boolean).join(' · ')))
    }

    const star = el('button', 'star', state.favorites.has(id) ? '★' : '☆')
    star.onclick = e => {
      e.stopPropagation()
      toggleFav(id)
    }

    row.append(img, n, star)
    row.onclick = () => select(c)
    chancolInner.append(row)
  }
}

// A row is rebuilt only when something that affects its layout changes: its
// vertical position, or its guide data arriving. Keyed on both, so the async EPG
// fetch actually replaces the "Loading…" placeholder.
const rowSig = new Map()

function renderProgrammes(first, last, tFrom, tTo) {
  const keep = new Set()
  for (let i = first; i < last; i++) keep.add(state.filtered[i].id)

  const q = $('#search').value.trim().toLowerCase()
  const sigOf = (c, i) => {
    const rows = state.epg.get(c.id)
    const epg = rows === undefined ? 'loading' : rows === null || !rows.length ? 'none' : rows.length
    return `${i}:${epg}:${q}`
  }

  const stale = new Set()
  for (let i = first; i < last; i++) {
    const c = state.filtered[i]
    if (rowSig.get(c.id) !== sigOf(c, i)) stale.add(c.id)
  }

  for (const node of [...gridInner.children]) {
    if (node.id === 'nowline') continue
    const ch = node.dataset.ch
    if (!keep.has(ch) || stale.has(ch)) {
      node.remove()
      if (!keep.has(ch)) rowSig.delete(ch)
    }
  }

  const now = Date.now()
  for (let i = first; i < last; i++) {
    const c = state.filtered[i]
    if (!stale.has(c.id)) continue
    rowSig.set(c.id, sigOf(c, i))

    const rows = state.epg.get(c.id)
    const y = i * ROW_H

    if (!rows || !rows.length) {
      const box = el('div', 'prog empty')
      box.dataset.ch = c.id
      box.dataset.left = 0
      box.dataset.w = timeToPx(state.t1)
      box.style.left = '0px'
      box.style.top = `${y}px`
      box.style.width = `${timeToPx(state.t1)}px`
      const pin = el('div', 'pin')
      pin.append(el('div', 'pt', state.epg.has(c.id) ? 'No guide data' : 'Loading…'))
      box.append(pin)
      box.onclick = () => select(c)
      gridInner.append(box)
      continue
    }

    for (const p of rows) {
      if (p.e <= state.t0 || p.s >= state.t1) continue
      const x = Math.max(0, timeToPx(p.s))
      const w = Math.max(2, timeToPx(Math.min(p.e, state.t1)) - x)
      const live = p.s <= now && p.e > now
      // ring the programmes the search actually matched, so the hit is findable
      // in the grid and not just asserted in the channel row
      const hit = q.length >= 2 && (p.t || '').toLowerCase().includes(q)
      const box = el('div', `prog${live ? ' live' : ''}${hit ? ' match' : ''}`)
      box.dataset.ch = c.id
      box.dataset.left = x
      box.dataset.w = w
      box.style.left = `${x}px`
      box.style.top = `${y}px`
      box.style.width = `${w - 1}px`
      const pin = el('div', 'pin')
      pin.append(el('div', 'pt', p.t || 'Untitled'))
      if (w > 90) pin.append(el('div', 'pd', `${fmtTime(p.s)} – ${fmtTime(p.e)}`))
      box.append(pin)
      box.title = `${p.t || ''}\n${fmtTime(p.s)} – ${fmtTime(p.e)}${p.d ? '\n\n' + p.d : ''}`
      box.onclick = () => select(c)
      gridInner.append(box)
    }
  }
}

/* ─────────────────────────── epg fetch ────────────────────── */

let epgTimer = 0
function fetchEpgFor(channels) {
  const need = channels.map(c => c.id).filter(id => !state.epg.has(id) && !state.pending.has(id))
  if (!need.length) return
  need.forEach(id => state.pending.add(id))

  clearTimeout(epgTimer)
  epgTimer = setTimeout(async () => {
    const ids = [...state.pending]
    state.pending.clear()
    try {
      const res = await fetch(
        `/api/epg?from=${state.t0}&to=${state.t1}&ids=${encodeURIComponent(ids.join(','))}`
      )
      const data = await res.json()
      for (const id of ids) state.epg.set(id, data[id] || null)
      render()
    } catch {
      ids.forEach(id => state.epg.delete(id))
    }
  }, 60)
}

async function refreshEpgIds() {
  try {
    const ids = await (await fetch('/api/epg/ids')).json()
    state.epgIds = new Set(ids)
  } catch {}
}

/**
 * The guide refreshes in the background on first run. Poll for the result, and
 * for progress — the IPC status channel only exists under Electron, and a
 * reload would otherwise lose an in-flight download's bar.
 */
let polling = false
function pollEpg() {
  if (polling) return
  polling = true
  let lastCount = -1
  setInterval(async () => {
    try {
      const s = await (await fetch('/api/epg/status')).json()
      // covers a reload mid-download, when the IPC status messages are long gone
      if (s.progress?.active) setStatus(s.progress)

      if (s.channels !== lastCount) {
        lastCount = s.channels
        state.epg.clear() // guide changed underneath us
        state.pending.clear()
        await refreshEpgIds()
        renderEpgStats(s)
        applyFilters() // "Guide only" may now match many more channels
      }
    } catch {}
  }, 5000)
}

/* ─────────────────────────── player ───────────────────────── */

const video = $('#video')
let hls = null
let failover = []

function select(channel, { autoplay = true } = {}) {
  state.playing = channel
  $('#player').classList.remove('collapsed')

  $('#np-logo').src = channel.logo || ''
  $('#np-name').textContent = channel.name
  $('#np-meta').textContent = [
    channel.country,
    channel.categories.join(', '),
    `${channel.streams.length} source${channel.streams.length > 1 ? 's' : ''}`
  ]
    .filter(Boolean)
    .join(' · ')

  const picker = $('#stream-picker')
  picker.innerHTML = ''
  channel.streams.forEach((s, i) => {
    const bits = [s.quality || 'auto', s.feed, s.label].filter(Boolean)
    picker.append(new Option(bits.join(' · ') || `Source ${i + 1}`, s.sid))
  })
  picker.onchange = () => {
    const s = channel.streams.find(x => x.sid === picker.value)
    failover = []
    if (s) play(s)
  }

  updateNowNext(channel)
  updateFavButton(channel)
  saveSettings({ lastChannel: channel.id })
  render()

  if (autoplay) {
    failover = channel.streams.slice(1)
    play(channel.streams[0])
  }
}

function updateNowNext(channel) {
  const box = $('#np-now')
  box.innerHTML = ''
  const rows = state.epg.get(channel.id)
  const now = Date.now()
  const cur = rows?.find(p => p.s <= now && p.e > now)
  const next = rows?.find(p => p.s > now)

  if (!cur && !next) {
    box.append(el('div', 'none', 'No guide data for this channel'))
    return
  }
  if (cur) {
    box.append(el('div', 't', cur.t || 'Untitled'))
    box.append(el('div', 'time', `${fmtTime(cur.s)} – ${fmtTime(cur.e)}  ·  on now`))
    if (cur.d) box.append(el('div', 'd', cur.d))
  }
  if (next) {
    const n = el('div', 'time')
    n.style.marginTop = '8px'
    n.textContent = `Next ${fmtTime(next.s)}: ${next.t || 'Untitled'}`
    box.append(n)
  }
}

// A dead iptv-org stream often does not error — it simply never delivers a
// segment, and hls.js waits forever. Without this the UI spins indefinitely and
// never tries the channel's other sources.
const STALL_TIMEOUT_MS = 14000
let stallTimer = 0
let playToken = 0

function play(stream) {
  if (!stream) return
  const err = $('#player-error')
  err.classList.add('hidden')
  $('#player-spinner').classList.remove('hidden')

  if (hls) {
    hls.destroy()
    hls = null
  }
  clearTimeout(stallTimer)
  const token = ++playToken // ignore callbacks from a stream we've moved on from
  video.volume = state.settings.volume ?? 1

  const onFail = reason => {
    if (token !== playToken) return
    clearTimeout(stallTimer)
    $('#player-spinner').classList.add('hidden')
    const next = failover.shift()
    if (next) {
      const label = next.quality || next.label || 'next source'
      setStatus(`${state.playing?.name}: source failed (${reason}) — trying ${label}…`)
      $('#stream-picker').value = next.sid
      play(next)
      return
    }
    err.textContent = `Could not play this channel (${reason}). About 1 in 4 iptv-org streams are geo-blocked or only broadcast part-time — try another channel.`
    err.classList.remove('hidden')
  }

  stallTimer = setTimeout(() => onFail('no video after 14s'), STALL_TIMEOUT_MS)

  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({ lowLatencyMode: true, backBufferLength: 30, manifestLoadingMaxRetry: 2 })
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return
      // Live streams drop the odd segment. Once we're actually playing, a fatal
      // network error means "hiccup", not "dead channel" — recover in place
      // instead of switching source and flashing an error over good video.
      const live = video.readyState > 2 && !video.paused
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (live) return hls.startLoad()
        return onFail('network')
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) return hls.recoverMediaError()
      if (live) return
      onFail(data.details || 'fatal')
    })
    hls.loadSource(stream.src)
    hls.attachMedia(video)
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}))
  } else {
    video.src = stream.src // Safari / native HLS
    video.play().catch(() => {})
    video.onerror = () => onFail('media error')
  }

  video.onplaying = () => {
    clearTimeout(stallTimer)
    $('#player-spinner').classList.add('hidden')
    err.classList.add('hidden')
    setStatus(`Playing ${state.playing?.name || ''}`)
  }
}

function stop() {
  playToken++ // cancel any in-flight failover for the stream we're abandoning
  clearTimeout(stallTimer)
  cancelSleep({ silent: true }) // nothing is playing; a countdown to stop it is noise
  failover = []
  if (hls) {
    hls.destroy()
    hls = null
  }
  video.removeAttribute('src')
  video.load()
  state.playing = null
  if (document.fullscreenElement) document.exitFullscreen()
  toggleTheater(false) // closing the player in theater mode would leave a blank window
  $('#player').classList.add('collapsed')
  render()
}

/* ───────────────────── player layout ──────────────────────── */

const app = $('#app')
const DEFAULT_PLAYER_H = Math.round(window.innerHeight * 0.46)

function setPlayerHeight(px) {
  // leave room for the toolbar + a few guide rows, and never exceed the window
  const h = Math.max(180, Math.min(px, window.innerHeight - 190))
  document.documentElement.style.setProperty('--player-h', `${h}px`)
  schedule() // the guide viewport changed size; re-virtualise
  return h
}

function applyLayout() {
  // Theater hides the guide entirely, so honouring a persisted `theater: true`
  // at startup — before anything is playing — would open to a black window.
  const theater = !!state.settings.theater && !!state.playing
  app.classList.toggle('theater', theater)
  app.classList.toggle('no-side', !!state.settings.noSide)
  $('#btn-theater').classList.toggle('on', theater)
  if (state.settings.playerH) setPlayerHeight(state.settings.playerH)
  schedule()
}

function toggleTheater(on) {
  const next = on ?? !state.settings.theater
  saveSettings({ theater: next })
  applyLayout()
}

// drag-to-resize
let dragFrom = null
$('#splitter').addEventListener('mousedown', e => {
  dragFrom = { y: e.clientY, h: $('#player').getBoundingClientRect().height }
  document.body.classList.add('resizing')
  e.preventDefault()
})
window.addEventListener('mousemove', e => {
  if (!dragFrom) return
  setPlayerHeight(dragFrom.h + (e.clientY - dragFrom.y))
})
window.addEventListener('mouseup', () => {
  if (!dragFrom) return
  dragFrom = null
  document.body.classList.remove('resizing')
  saveSettings({ playerH: $('#player').getBoundingClientRect().height })
})
$('#splitter').addEventListener('dblclick', () => {
  saveSettings({ playerH: setPlayerHeight(DEFAULT_PLAYER_H) })
})

const goFullscreen = () => {
  const target = $('#player-video')
  if (document.fullscreenElement) document.exitFullscreen()
  else target.requestFullscreen?.()
}

video.addEventListener('volumechange', () => saveSettings({ volume: video.volume }))
video.addEventListener('dblclick', goFullscreen)
// if frames are advancing, whatever we warned about is over — don't leave a
// stale error banner sitting on top of good video
video.addEventListener('timeupdate', () => {
  if (!video.paused && video.readyState > 2) {
    $('#player-error').classList.add('hidden')
    $('#player-spinner').classList.add('hidden')
  }
})
$('#btn-close-player').onclick = stop
$('#btn-fullscreen').onclick = goFullscreen
$('#btn-theater').onclick = () => toggleTheater()
$('#btn-side').onclick = () => {
  saveSettings({ noSide: !state.settings.noSide })
  applyLayout()
}
$('#btn-fav').onclick = () => state.playing && toggleFav(state.playing.id)

function updateFavButton(channel) {
  const on = state.favorites.has(channel.id)
  $('#btn-fav').textContent = on ? '★ Favourited' : '☆ Favourite'
}

function toggleFav(id) {
  if (state.favorites.has(id)) state.favorites.delete(id)
  else state.favorites.add(id)
  saveSettings({ favorites: [...state.favorites] })
  if (state.playing) updateFavButton(state.playing)
  applyFilters()
}

/* ────────────────────────── sleep timer ───────────────────────
 *
 * Stop playing after a while, for falling asleep to. Two things this has to get
 * right that a naive `setTimeout(stop, mins * 60000)` does not:
 *
 *   1. It must not drift. The countdown is derived from a wall-clock deadline
 *      and re-read every tick, so a throttled or delayed tick loses nothing.
 *      (The window also runs with backgroundThrottling off — see main.js — since
 *      closing to the tray is the normal way to fall asleep to this.)
 *   2. It must not cut out mid-sentence. The last 20 seconds fade the volume
 *      down, so you get a warning rather than sudden silence; cancelling during
 *      the fade puts the volume back exactly where you had it.
 *
 * "End of this programme" is the option a plain player can't offer — we know
 * when the show ends, so use it.
 */
const SLEEP_FADE_MS = 20000
const sleep = { endsAt: 0, tick: 0, volume: null }

const sleepActive = () => sleep.endsAt > 0

function armSleep(endsAt, label) {
  cancelSleep({ silent: true })
  if (endsAt <= Date.now() + 1000) return
  sleep.endsAt = endsAt
  sleep.tick = setInterval(sleepTick, 500)
  sleepTick()
  setStatus(`Sleep timer set — ${label}`)
}

function cancelSleep({ silent = false } = {}) {
  clearInterval(sleep.tick)
  sleep.tick = 0
  sleep.endsAt = 0
  if (sleep.volume !== null) {
    video.volume = sleep.volume // we were mid-fade; give the user their volume back
    sleep.volume = null
  }
  renderSleepButton()
  if (!silent) setStatus('Sleep timer off')
}

function sleepTick() {
  const left = sleep.endsAt - Date.now()

  if (left <= 0) {
    cancelSleep({ silent: true }) // also puts the volume back, so the next channel isn't silent
    stop()
    setStatus('Sleep timer — stopped playing. Good night.')
    return
  }

  // ease the volume down over the final stretch instead of cutting out
  if (left <= SLEEP_FADE_MS) {
    if (sleep.volume === null) sleep.volume = video.volume
    video.volume = Math.max(0, sleep.volume * (left / SLEEP_FADE_MS))
  } else if (sleep.volume !== null) {
    video.volume = sleep.volume // deadline was pushed back out of the fade window
    sleep.volume = null
  }

  renderSleepButton(left)
}

const fmtLeft = ms => {
  const s = Math.ceil(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${String(m).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`
}

function renderSleepButton(left = sleep.endsAt - Date.now()) {
  const btn = $('#btn-sleep')
  const on = sleepActive()
  btn.classList.toggle('on', on)
  btn.textContent = on ? `⏱ ${fmtLeft(left)}` : '⏱ Sleep'
  btn.title = on
    ? `Playback stops at ${fmtTime(sleep.endsAt)} — click to change or cancel`
    : 'Stop playing after a while (S)'
}

/** The programme currently on the channel we're watching, if we know it. */
function currentProgramme() {
  if (!state.playing) return null
  const now = Date.now()
  return state.epg.get(state.playing.id)?.find(p => p.s <= now && p.e > now) || null
}

function openSleepMenu() {
  const menu = $('#sleep-menu')
  menu.innerHTML = ''

  const item = (label, hint, onclick, { danger = false } = {}) => {
    const b = el('button', `menu-item${danger ? ' danger' : ''}`)
    b.append(el('span', 'mi-label', label))
    if (hint) b.append(el('span', 'mi-hint', hint))
    b.onclick = () => {
      closeSleepMenu()
      onclick()
    }
    menu.append(b)
  }

  if (sleepActive()) {
    item('Cancel sleep timer', fmtLeft(sleep.endsAt - Date.now()) + ' left', () => cancelSleep(), {
      danger: true
    })
  }

  // the guide-aware option: only offered when we actually know when the show ends
  const prog = currentProgramme()
  if (prog && prog.e > Date.now() + 60000) {
    item('End of this programme', `${prog.t} — ends ${fmtTime(prog.e)}`, () =>
      armSleep(prog.e, `stops at ${fmtTime(prog.e)}, when "${prog.t}" ends`)
    )
  }

  for (const mins of [15, 30, 45, 60, 90, 120]) {
    const at = Date.now() + mins * 60000
    item(
      mins >= 60 && mins % 60 === 0 ? `${mins / 60} hour${mins > 60 ? 's' : ''}` : `${mins} minutes`,
      `until ${fmtTime(at)}`,
      () => armSleep(at, `stops at ${fmtTime(at)}`)
    )
  }

  menu.classList.remove('hidden')
  positionMenu(menu, $('#btn-sleep'))
  document.addEventListener('pointerdown', onDocDown, true)
  window.addEventListener('resize', closeSleepMenu)
}

/**
 * Put `menu` next to `btn` in viewport coordinates.
 *
 * The obvious CSS — `position:absolute; bottom:100%` on the button's wrapper —
 * looked right and wasn't: the controls live at the bottom of a short,
 * overflow-hidden side panel, so a seven-item menu opening upward was simply cut
 * off at the top of the window. Prefer above, fall back to below, and if neither
 * fits, take the roomier side and let the menu scroll.
 */
function positionMenu(menu, btn) {
  const GAP = 6
  const b = btn.getBoundingClientRect()
  menu.style.maxHeight = ''
  const h = menu.offsetHeight
  const above = b.top - GAP
  const below = window.innerHeight - b.bottom - GAP

  let top
  if (h <= above) top = b.top - h - GAP
  else if (h <= below) top = b.bottom + GAP
  else if (above >= below) {
    menu.style.maxHeight = `${above - GAP}px`
    top = GAP
  } else {
    menu.style.maxHeight = `${below - GAP}px`
    top = b.bottom + GAP
  }

  const w = menu.offsetWidth
  const left = Math.max(GAP, Math.min(b.left, window.innerWidth - w - GAP))
  menu.style.top = `${Math.max(GAP, top)}px`
  menu.style.left = `${left}px`
}

function closeSleepMenu() {
  $('#sleep-menu').classList.add('hidden')
  document.removeEventListener('pointerdown', onDocDown, true)
  window.removeEventListener('resize', closeSleepMenu)
}

function onDocDown(e) {
  if (!e.target.closest('.menu-wrap')) closeSleepMenu()
}

$('#btn-sleep').onclick = () => {
  if ($('#sleep-menu').classList.contains('hidden')) openSleepMenu()
  else closeSleepMenu()
}

/* ─────────────────────────── settings ─────────────────────── */

async function saveSettings(patch) {
  Object.assign(state.settings, patch)
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    })
  } catch {}
}

function renderEpgStats(stats) {
  const box = $('#epg-stats')
  if (!box) return
  box.innerHTML = ''
  const total = state.filtered.length || state.channels.length

  const head = el('div', 'stat')
  head.append(el('div', 's-name', 'Channels with a guide'))
  head.append(el('div', 's-num', `${stats.channels || 0}`))
  box.append(head)

  // The mirrors only carry ~12-24 h ahead for a typical channel, so this number
  // falls through the day. It's why the guide refreshes before the 24 h mark.
  if (stats.channels) {
    const cov = el('div', 'stat')
    cov.append(el('div', 's-name', 'Listings left (median channel)'))
    cov.append(el('div', 's-num', `${Math.max(0, stats.forwardHours || 0)} h`))
    box.append(cov)
  }

  for (const [name, s] of Object.entries(stats.sources || {})) {
    const row = el('div', 'stat')
    row.append(el('div', 's-name', name))
    if (s.kind) row.append(el('div', 's-kind', s.kind))
    row.append(
      el('div', 's-num', s.error ? 'failed' : `${s.channels || 0} ch · ${(s.programmes || 0).toLocaleString()} progs`)
    )
    box.append(row)
  }
  void total
}

async function openSettings() {
  $('#modal').classList.remove('hidden')
  $('#s-scope').checked = state.settings.scope === 'all'
  $('#s-nsfw').checked = state.settings.hideNsfw !== false

  $('#s-scope').onchange = e => {
    saveSettings({ scope: e.target.checked ? 'all' : 'default' })
    applyFilters()
  }
  $('#s-nsfw').onchange = e => {
    saveSettings({ hideNsfw: e.target.checked })
    applyFilters()
  }

  $('#btn-refresh-epg').onclick = async () => {
    $('#btn-refresh-epg').disabled = true
    setProgress('Starting refresh…', null, true) // don't wait 5s for the first poll
    await fetch('/api/epg/refresh', { method: 'POST' })
    setTimeout(() => ($('#btn-refresh-epg').disabled = false), 4000)
  }

  renderEpgStats(await (await fetch('/api/epg/status')).json())
  renderSites(await (await fetch('/api/scraper/sites')).json())

  const info = await window.native?.info()
  if (info) $('#about').textContent = `IPTV Guide ${info.version} · data in ${info.userData}`
}

function renderSites(sites) {
  const box = $('#sites')
  box.innerHTML = ''
  for (const s of sites) {
    const row = el('div', 'site')
    row.append(el('div', 's-name', s.site))
    const gain = el('div', 's-gain')
    gain.innerHTML = s.missing
      ? `could fill <b>${s.missing}</b> channels with no guide (of ${s.covers} it knows)`
      : `nothing to add — all ${s.covers} already covered`
    row.append(gain)

    const btn = el('button', 'btn', 'Scrape')
    btn.disabled = !s.missing
    btn.onclick = () => runScrape(s.site, btn)
    row.append(btn)
    box.append(row)
  }
}

async function runScrape(site, btn) {
  btn.disabled = true
  btn.textContent = 'Scraping…'
  const log = $('#scrape-log')
  log.classList.remove('hidden')
  log.textContent = ''

  await fetch('/api/scraper/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ site, days: 2 })
  })

  const iv = setInterval(async () => {
    const st = await (await fetch('/api/scraper/status')).json()
    log.textContent = st.log.join('\n')
    log.scrollTop = log.scrollHeight
    if (!st.running) {
      clearInterval(iv)
      btn.textContent = 'Scrape'
      state.epg.clear()
      state.pending.clear()
      await refreshEpgIds() // the scrape just gave some channels a guide
      applyFilters()
      renderEpgStats(await (await fetch('/api/epg/status')).json())
      renderSites(await (await fetch('/api/scraper/sites')).json())
    }
  }, 1000)
}

/* ─────────────────────────── keys ─────────────────────────── */

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return
  if (e.key === '/') {
    e.preventDefault()
    $('#search').focus()
  }
  if (e.key === 'Escape') {
    // unwind one layer at a time, most-nested first
    if (!$('#sleep-menu').classList.contains('hidden')) closeSleepMenu()
    else if (!$('#modal').classList.contains('hidden')) $('#modal').classList.add('hidden')
    else if (document.fullscreenElement) document.exitFullscreen()
    else if (state.settings.theater) toggleTheater(false)
    else stop()
  }
  if (e.key === 'f' && state.playing) goFullscreen()
  if (e.key === 't' && state.playing) toggleTheater()
  if (e.key === 's' && state.playing) $('#btn-sleep').click()
  if (e.key === ' ' && state.playing) {
    e.preventDefault()
    video.paused ? video.play().catch(() => {}) : video.pause()
  }
})

// leaving fullscreen via Esc/F11 must not leave the layout stale
document.addEventListener('fullscreenchange', schedule)
window.addEventListener('resize', () => {
  if (state.settings.playerH) setPlayerHeight(state.settings.playerH)
})

boot().catch(err => {
  setStatus(`Startup failed: ${err.message}`)
  console.error(err)
})
