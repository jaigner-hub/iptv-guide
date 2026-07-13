'use strict'
// hls.js ships as a plain UMD bundle; copy it next to the renderer so the page
// can <script src> it without a bundler in the build.
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const out = path.join(root, 'src', 'renderer', 'vendor')
fs.mkdirSync(out, { recursive: true })

const candidates = [
  'node_modules/hls.js/dist/hls.min.js',
  'node_modules/hls.js/dist/hls.js'
]

const src = candidates.map(c => path.join(root, c)).find(fs.existsSync)
if (!src) {
  console.warn('[vendor] hls.js not found — run npm install first')
  process.exit(0)
}

fs.copyFileSync(src, path.join(out, 'hls.min.js'))
console.log(`[vendor] hls.js -> src/renderer/vendor/hls.min.js (${(fs.statSync(src).size / 1024).toFixed(0)} KB)`)
