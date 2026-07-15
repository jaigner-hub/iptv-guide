# IPTV Guide

A TV-guide style desktop app for the [iptv-org](https://github.com/iptv-org/iptv) stream catalog:
scroll a real programme grid, click a show, watch the channel.

Ships as a Windows installer with a tray icon. No Node, no WSL, nothing to configure.

![grid](build/icon.png)

---

## Run it

```sh
npm install
npm start          # dev
npm run dist       # -> release/  installer (.exe) + portable (.zip)
```

The build is **unsigned**, so Windows SmartScreen shows "Windows protected your PC" and hides the
Run button behind a *More info* link. The ZIP sidesteps that — unzip and run. `release/READ-ME-FIRST.txt`
is written for whoever you hand the build to.

The app code is platform-neutral — there are no native dependencies — so only *packaging* is
OS-specific. Linux: `npm run dist:linux`.

**macOS without a Mac.** Building a `.dmg` needs macOS tooling, but you don't need to own a Mac:
the **Build macOS** GitHub Action (`.github/workflows/build-mac.yml`) builds a universal `.dmg` +
`.zip` on a GitHub-hosted Mac. It's **manual only** — Actions tab → *Build macOS* → *Run workflow* —
so it never spends runner minutes on its own. Leave the input blank to just download the artifact,
or pass a release tag (e.g. `v0.1.1`) to attach the build to that release.

The Mac build is **unsigned** (no Apple Developer certificate). It launches, but Gatekeeper
quarantines anything downloaded, so first-run is right-click → **Open**, or:
`xattr -dr com.apple.quarantine "/Applications/IPTV Guide.app"`. This is macOS's equivalent of the
Windows SmartScreen prompt, and a $99/yr Apple Developer account + notarization is what removes it.

## Check it works

```sh
node scripts/selftest.js          # catalog -> server -> real stream through the proxy
node scripts/selftest.js --epg    # ...and rebuild the guide from mirrors (~500 MB, slow)
npx electron scripts/uitest.js    # loads the real UI, plays a real channel, reports console errors
```

---

## How it fits together

```
Electron main ── http://127.0.0.1:<random>   ← the window loads this, so everything
      │                                        is same-origin and CORS never applies
      ├── /api/*     catalog, guide, settings, scraper
      ├── /p/:sid/*  stream proxy  (injects User-Agent / Referer, rewrites HLS manifests)
      └── /logo/*    logo proxy    (imgur hotlink-blocks in some regions)
```

### The stream proxy is not optional

Roughly **1,100 iptv-org streams 403 without a `User-Agent` or `Referer` header**, and a browser
is forbidden from setting either from JavaScript. So every stream is fetched by the Node side,
which injects the headers from `streams.json` and rewrites each HLS manifest so segments, keys
and variant playlists come back through the proxy too.

### The guide is the hard part

**iptv-org publishes no usable EPG.** This surprises people, so, concretely:

- `guides.json` is a *scraper recipe index*, not a feed directory — its `sources[]` field is
  populated on **2 of 179,549 records**.
- The `x-tvg-url` in `index.m3u` points at a **2-channel demo file**.

So the guide is assembled in layers, best source winning:

| Layer | Source | How it joins | Coverage |
|---|---|---|---|
| 1 | `i.mjh.nz` | **exact** — `guides.json` `site_id` is `<file>#<xmltvId>` | ~860 channels |
| 2 | `epgshare01.online` | name match on `<display-name>` | ~1,740 channels |
| 3 | on-demand scrape | exact — we choose the `xmltv_id` | as much as you want |

Layers 1+2 land at **~2,380 channels**. Channels with no match display *"No guide data"* rather
than inventing something.

#### Matching on name is dangerous, and the naive version was wrong

A first cut bound channels to any XMLTV id whose name normalised to the same string. That put
*European* Fox listings on US **Fox** (`FOX.cz`, `FOX.HD.cy`, `Fox+.dk`), and — since normalising
strips non-ASCII — collapsed `БНТ1` to `"1"`, so **MBC1** pulled programmes from Bulgaria, Greece,
Israel and Japan. It also let several ids feed one channel, concatenating two countries' schedules
into a single row: **1,476 channels** were affected, with **8,520** cross-country bindings.

Three rules now hold on both layers:

1. **a key must be distinctive** — ≥3 characters and not purely numeric;
2. **countries must not conflict** — `FOX.cz` may never feed a US channel, and a US channel is not
   given the `Plex/es` or Australian-Foxtel listing when a matching one exists;
3. **exactly one source id per channel** — best match wins; schedules are never concatenated.

This costs coverage (3,060 → 2,383 channels) because the bindings it drops were simply wrong. The
EPG cache is versioned, so an upgrade discards a guide built by the old matcher instead of serving
it.

> The `ALL_SOURCES1` feed is >512 MB uncompressed — past Node's max string length. The XMLTV
> parser streams; it never buffers a document.

A refresh takes a minute or two, so it reports real progress — bytes downloaded against
`content-length` (~184 MB gzipped), shown in the status bar and in Settings. The new guide is
built in a staging map and swapped in only when complete, so the guide you're looking at stays
live for the whole download rather than blanking out.

### Search covers programmes, and that forces it server-side

The search box matches channel names **and programme titles** across the whole guide, so
"world cup" surfaces the 44 channels carrying it, each row showing the programme and when it
starts. Clicking that line jumps the grid to it.

The search runs in the **main process** (`/api/epg/search`), not the renderer. It has to: the
renderer only holds programmes for the handful of rows scrolled into view, so a client-side
search would find only what the user had already looked at — the exact bug that made the
"Guide only" filter return one screenful of its 1,355 matches. Anything that needs to answer
across *all* channels has to be answered by the side that holds all of them. A search over
2,383 channels' programmes takes ~25 ms, so there is no reason to cache it.

It matches **titles only**. Matching descriptions as well sounded more generous and was worse:
"football" returned *Queen Of Katwe* and "seinfeld" returned *The Johnny Carson Show*, because
the term was buried in a synopsis. A result whose title has nothing to do with what you typed
just reads as a broken search.

### Sleep timer

`⏱ Sleep` in the player controls (or <kbd>S</kbd>): 15 min … 2 h, or **End of this programme** —
the option a plain player can't offer, because we know when the show ends. The chip counts down
while it's armed, and the last 20 seconds fade the volume out rather than cutting to silence; cancel
during the fade and your volume comes back exactly where it was.

Two things it has to get right, and a `setTimeout(stop, mins * 60000)` gets neither:

- **It must not drift.** The countdown is derived from a wall-clock deadline and re-read each tick,
  so a delayed or throttled tick loses nothing.
- **It must survive the window being hidden.** Closing to the tray while audio plays is the normal
  way to fall asleep to this — and Chromium throttles timers in a hidden window to once a second,
  then once a minute. The window runs with `backgroundThrottling: false`.

### Filling the gaps: scraping from the GUI

Settings → **Fill gaps by scraping**. Pick a site, hit Scrape.

This drives iptv-org's own `epg-grabber` engine, but skips their TypeScript CLI — so there's no
`tsx`, no `@swc`, and **no native binaries** in the installer. It runs on Electron's bundled Node,
so the user needs nothing installed.

The trick that makes it fast: we **generate the `channels.xml`**, containing only the channels you
are actually missing a guide for. A full-site scrape is hours; your missing channels is seconds.
And because we pick the `xmltv_id`, the output keys straight to the catalog — no name matching.

Site configs are **vendored and pinned** in `vendor/sites/`, not downloaded at runtime: they are
executable JavaScript, and fetching + `require`-ing remote code on a user's machine has no place
in an installer.

Working sites: `plex.tv`, `xumo.tv`, `tvguide.com`, `tvpassport.com`, `ontvtonight.com`.
(`tvtv.us` 403s and `pluto.tv`'s config 404s upstream — dropped rather than shipped broken.)

---

## Notes

- **Not every stream plays.** ~1,200 are geo-blocked and ~1,850 are part-time ("Not 24/7").
  The player fails over to the next source automatically.
- Closing the window hides to tray; quit from the tray menu.
- `/` focuses search, `f` fullscreens, `s` sets a sleep timer, `t` is theater, `Esc` closes the player.
- The timeline shows 24 h. A search hit beyond it still tells you when it's on, but can't be
  jumped to.

### When the guide refreshes

Data lives in `%APPDATA%/IPTV Guide/` — catalog cached 24 h, guide at most 24 h. But **age is the
wrong question on its own**, and getting this wrong was visible: the mirrors advertise 72 hours of
listings, so the refresh check asked whether the furthest programme was ≥12 h out. That 72 h is the
*deepest* channel. The **median** channel carries only ~12–24 h, and 12 h after a fetch it is down
to about **1 h** left — at which point a single channel with listings three days out was still
holding the whole guide "fresh" while **785 of 2,383 channels had run dry**, filling the grid with
*"No guide data"*.

So staleness is measured on the median channel's remaining coverage, and the guide refreshes once
that drops under 3 h. Settings shows the number. A normal launch still downloads nothing.

## Layout

```
src/main/     catalog.js  iptv-org API -> channel working set
              epg.js      layered guide resolution
              xmltv.js    streaming XMLTV parser (never buffers)
              scraper.js  drives epg-grabber against a generated channels.xml
              server.js   API + stream proxy + static
              main.js     window, tray, lifecycle
src/renderer/ app.js      virtualised guide grid + player
vendor/sites/ pinned iptv-org site configs
```
