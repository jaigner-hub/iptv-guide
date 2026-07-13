'use strict'
/**
 * Attach to the *packaged* app over the Chrome DevTools Protocol and observe what
 * the player actually does when a channel is clicked. Run this on Windows:
 *
 *   1) start "IPTV Guide.exe" --remote-debugging-port=9222
 *   2) node scripts/cdp.js
 *
 * Dev-mode tests exercise the source tree; this exercises the shipped binary.
 */
const PORT = 9222

const rpc = (ws, state) => (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++state.id
    state.pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => reject(new Error(`${method} timed out`)), 20000)
  })

;(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = targets.find(t => t.type === 'page')
  if (!page) {
    console.log('no page target — is the app running with --remote-debugging-port=9222?')
    process.exit(1)
  }
  console.log(`attached: ${page.url}`)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const state = { id: 0, pending: new Map() }
  const consoleMsgs = []
  const netFails = []

  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data)
    if (msg.id && state.pending.has(msg.id)) {
      const { resolve, reject } = state.pending.get(msg.id)
      state.pending.delete(msg.id)
      return msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      consoleMsgs.push(
        `[${msg.params.type}] ` + msg.params.args.map(a => a.value ?? a.description ?? '?').join(' ')
      )
    }
    if (msg.method === 'Log.entryAdded') {
      consoleMsgs.push(`[${msg.params.entry.level}] ${msg.params.entry.text}`)
    }
    if (msg.method === 'Network.loadingFailed') {
      netFails.push(`${msg.params.type} ${msg.params.errorText}`)
    }
  })

  await new Promise(r => ws.addEventListener('open', r))
  const send = rpc(ws, state)
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Network.enable')

  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw')
    return r.result.value
  }

  console.log('\n[environment in the shipped app]')
  const env = await evaluate(`(() => ({
    hlsLoaded: typeof window.Hls !== 'undefined',
    hlsSupported: typeof window.Hls !== 'undefined' && Hls.isSupported(),
    mse: typeof MediaSource !== 'undefined',
    canPlayTs: document.createElement('video').canPlayType('video/mp2t'),
    canPlayH264: document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"'),
    channels: document.querySelectorAll('#chancol-inner .chan').length,
    status: document.querySelector('#status')?.textContent
  }))()`)
  console.log(env)

  console.log('\n[clicking the first channel, watching hls.js events]')
  await evaluate(`(() => {
    window.__diag = { events: [], errors: [] }
    const v = document.querySelector('#video')
    for (const e of ['loadstart','loadedmetadata','canplay','playing','stalled','waiting','error'])
      v.addEventListener(e, () => window.__diag.events.push(e + '@' + v.readyState))
    if (window.Hls) {
      const origLoad = Hls.prototype.loadSource
      Hls.prototype.loadSource = function (url) {
        window.__diag.src = url
        this.on(Hls.Events.ERROR, (_e, d) =>
          window.__diag.errors.push(\`\${d.type}/\${d.details}\${d.response ? ' http' + d.response.code : ''}\${d.fatal ? ' FATAL' : ''}\`))
        return origLoad.call(this, url)
      }
    }
    document.querySelector('#chancol-inner .chan')?.click()
    return true
  })()`)

  await new Promise(r => setTimeout(r, 12000))

  const diag = await evaluate(`(() => {
    const v = document.querySelector('#video')
    return {
      channel: document.querySelector('#np-name')?.textContent,
      hlsSrc: window.__diag?.src,
      videoEvents: window.__diag?.events || [],
      hlsErrors: (window.__diag?.errors || []).slice(0, 8),
      readyState: v.readyState, networkState: v.networkState,
      size: v.videoWidth + 'x' + v.videoHeight,
      paused: v.paused, currentTime: +v.currentTime.toFixed(1),
      errorBanner: document.querySelector('#player-error')?.classList.contains('hidden')
        ? null : document.querySelector('#player-error')?.textContent,
      status: document.querySelector('#status')?.textContent
    }
  })()`)
  console.log(diag)

  console.log('\n[console]')
  console.log(consoleMsgs.length ? consoleMsgs.slice(0, 12).join('\n') : '  (none)')
  console.log('\n[failed network requests]')
  console.log(netFails.length ? [...new Set(netFails)].slice(0, 8).join('\n') : '  (none)')

  process.exit(0)
})().catch(e => {
  console.error('cdp failed:', e.message)
  process.exit(1)
})
