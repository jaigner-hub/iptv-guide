# CLAUDE.md

Electron TV-guide app over the iptv-org catalog. `README.md` explains *what it does and why*;
this file is the stuff that will waste your afternoon if you don't know it.

## Dev happens in WSL, but nothing runs there

The app is built and tested with **Windows** Node/Electron, driven from WSL through `cmd.exe`:

```sh
cmd.exe /c "npx electron scripts/uitest.js"     # NOT `npx electron ...`
cmd.exe /c "node scripts/selftest.js"
cmd.exe /c "npm run dist"
```

Running Linux Electron from WSL will appear to work and then mislead you. Two consequences:

- Windows Node can't see `/tmp` or any WSL-only path. A scratch script has to live **inside the
  project directory** (`./foo.tmp.js`) and use relative requires.
- `npm run dist` fails with `remove ...d3dcompiler_47.dll: Access is denied` if an Electron or
  `IPTV Guide.exe` process from an earlier test is still alive. Kill it first:
  `powershell.exe -NoProfile -Command "Get-Process 'IPTV Guide' -EA SilentlyContinue | Stop-Process -Force"`.

## Test before you claim

Every real bug in this project was found by running the thing, not by reading it. There are four
suites; run all of them after touching main or renderer:

```sh
cmd.exe /c "node scripts/selftest.js"             # catalog -> server -> real stream via the proxy
cmd.exe /c "npx electron scripts/uitest.js"       # real UI: guide renders, row reuse, search, playback
cmd.exe /c "npx electron scripts/boottest.js"     # cold start; --offline asserts the failure is *shown*
cmd.exe /c "npx electron scripts/stalltest.js"    # a dead stream must fail over, not hang
```

`scripts/shot.js` screenshots the window. **Use it.** The programme-search feature passed all its
assertions and the screenshot still showed a wall of "No guide data" next to hits captioned with
*yesterday's* airings — two real bugs no assertion had asked about.

When you fix a rendering bug, **revert the fix and confirm the test fails.** A test written after
the fact that has never seen the bug is not evidence.

`uitest` mutates `.selftest/settings.json` (it favourites a channel). It restores what it changed —
keep it that way, and address channels by `data-id`, never by row index: favourites sort to the top,
so the row at index 6 is not the row that was there a moment ago.

## Things that are load-bearing

**The stream proxy.** ~1,100 streams 403 without a `User-Agent`/`Referer`, and a browser cannot set
those from JS. Every stream goes through `/p/:sid/:b64url`, which injects the headers and rewrites
HLS manifests so segments/keys/variants come back through the proxy too. Don't "simplify" a stream
URL straight into the `<video>` tag.

**Anything that must answer across all channels belongs in the main process.** The renderer only
holds guide rows for the ~16 channels currently on screen. This has now caused the same bug twice:
the "Guide only" filter returned one screenful of its 1,355 matches, and a client-side programme
search would have found only what the user had already scrolled past. Both are served from the
main process (`/api/epg/ids`, `/api/epg/search`).

**The XMLTV parser must stream.** The `ALL_SOURCES1` feed is >512 MB uncompressed — past Node's max
string length. `xmltv.js` never buffers a document; don't make it.

**Guide joins are guilty until proven innocent.** Name-matching XMLTV ids to channels put Czech and
Cypriot *Fox* listings on US **Fox**, and normalising `БНТ1` to `"1"` fed **MBC1** from Bulgaria,
Greece, Israel and Japan — 1,476 channels, 8,520 cross-country bindings. Three rules hold in
`epg.js` and any new layer must too: a key must be ≥3 chars and non-numeric; countries may not
conflict; exactly one source id per channel (never concatenate two schedules). Bump `EPG_VERSION`
when the matcher changes so cached guides built by the old one are discarded.

**Guide staleness is measured on the median channel, not the furthest.** See README — taking the max
let one deep channel mask a third of the guide having run dry.

**Site configs are vendored and pinned** in `vendor/sites/`. They are executable JS. Never download
and `require` them at runtime.

## Renderer

The guide is a virtualised grid: rows are absolutely positioned and DOM nodes are reused across
renders, keyed by a signature. If you add anything to a row's appearance, **add it to `sigOf`** —
reusing a row without rebuilding it on a re-sort is what painted two channels on top of each other.
