# AGENTS.md: Aftermarket Tracker

This file is for AI coding agents (and humans) who maintain this app. Its most common job
is **fixing the scraper after the Forza wiki changes its page layout**. Read the
"Wiki layout contract" section before touching `src/main/parser.js`.

## What the app is

A Windows desktop app (Electron) that tracks which Forza Horizon 6 **Aftermarket Cars**
the user has collected. All game data comes live from the Fandom wiki:

- Index page: https://forza.fandom.com/wiki/Forza_Horizon_6/Cars/Aftermarket
- Location pages: https://forza.fandom.com/wiki/Forza_Horizon_6/Cars/Aftermarket/SOT1 (one per location code)
- Category used as a second discovery source: `Category:Aftermarket Car Locations (FH6)`

The UI shows one card per location (map image, code, progress bar). Clicking a card opens
its car list (grouped like the wiki: "Available at Launch", "Series N Update", "Notable
Vehicles", plus past Evolving World event pools), and then trivia. Clicking a car opens a
detail view: a big image, the six stats, flavor text, at-location photos, and (for
modified cars) the parts list, price breakdown and tuning tables.

## Layout

```
src/main/main.js         Electron entry: window, IPC, wimg:// image protocol, dev screenshot hook
src/main/preload.js      window.tracker API exposed to the renderer
src/main/wiki.js         MediaWiki API client + sync (revision checks, raw HTML cache, build step)
src/main/parser.js       ALL wiki-layout knowledge: HTML -> data. Pure functions (cheerio)
src/main/imageCache.js   On-disk image cache keyed by URL path, refreshed when the `cb` param changes
src/renderer/            index.html / app.js / styles.css: vanilla JS UI, no framework, no build step
scripts/check-wiki.js    Parser health check against the live wiki (run this after any parser change)
scripts/make-icon.py     Regenerates build/icon.png and src/renderer/icon.png (needs Pillow)
docs/                    README screenshots (re-take them with the screenshot hook below)
```

## Commands

```bash
npm install
npm start                  # run the app in dev
npm run check-wiki         # live parser health check; exit code 1 = something broke
npm run check-wiki -- --dump SOT1        # also print the parsed JSON for one location
npm run check-wiki -- --cache <dir> --force   # choose the cache dir, re-download everything
npm run dist               # build dist/AftermarketTracker-<version>-portable.exe
```

Dev hooks (used to check the UI without clicking around):

```bash
npx electron . --nosync=1 --open=SHI3 --car=3 --scroll=700 --screenshot=out.png --delay=4000
```

`--open` opens a location, `--car` is the index into that location's car list (all groups
in order), `--scroll` scrolls the modal, `--nosync` skips the background wiki check, and
`--screenshot` saves a PNG `--delay` ms after the first render and then quits.

## Data flow

1. `WikiSync.sync()` (wiki.js) calls `action=query&prop=info` for the index page and every
   location page. A page is downloaded again (`action=parse`) only when its `lastrevid` or
   `touched` changed. `touched` also changes when a template that the page uses is edited.
2. Raw HTML is stored in `<userData>/cache/pages/<CODE>.html` (`_index.html` for the index).
   Revision info lives in `cache/pages.json`.
3. `WikiSync.build()` parses **every** cached page with `parser.js`, links modified cars to
   parts lists and gallery photos, and writes `cache/data.json`.
4. When `PARSER_VERSION` in parser.js is bumped, `data.json` is rebuilt from the cached raw
   HTML on the next launch, so there is no re-download. **Bump it whenever the parsed output
   changes.**
5. Images go through `wimg://img/?u=<encoded static.wikia URL>`. `imageCache.js` caches
   each URL path (including its `scale-to-width-down/N` size) and downloads it again only
   when the `?cb=` value changes. Only `static.wikia.nocookie.net` is allowed.

User data lives in `%APPDATA%/Aftermarket Tracker/`:
- `collection.json`: checkboxes and settings. **Never break or reset this file.**
  - `checked[carKey]` is used when "Link identical cars" is on (the default).
  - `checkedLoc["CODE|carKey"]` is used when that setting is off.
  - `known[CODE]` lists the car keys the user has already seen; the NEW badges come from it.
- `cache/`: everything in here can be deleted and rebuilt.

### Car identity (`carKey`)

`"<link title>|<M|S>|<PI class><PI value>"`, e.g. `Ford Escort RS Cosworth|M|S1720`. It is
built from the car's wiki link title (not the display name), whether it is modified, and
its PI. **Changing this formula orphans users' saved checkboxes.** If you must change it,
write a migration in `app.js` `init()` that rewrites the old keys in `state.checked`,
`state.checkedLoc` and `state.known`.

## Wiki layout contract (what parser.js assumes)

The parser reads rendered HTML from `api.php?action=parse&prop=text`, **not** wikitext,
because flavor texts and other values are expanded from templates
(`{{FH6AftermarketLocation|...}}` with codes like `stc`, `be`, `gr`).

### Index page (`parseIndexPage`)
- An `h2` titled **"Locations"**, then one `h3` per region ("Sotoyama Region"; the " Region"
  suffix is stripped) with a table under each.
- Each table row links to `/wiki/Forza_Horizon_6/Cars/Aftermarket/<CODE>`. Codes match
  `^[A-Z]{2,4}\d{1,2}$`.
- The first cell may hold a map image that spans several rows (rowspan), as SHI4-SHI6 and
  LEG1-LEG2 do.
- Locations that only appear in the category get their region from a location with the same
  code prefix (NAN4 → Nangan), or "Other".

### Location page (`parseLocationPage`)
- Section structure comes from `h2`/`h3`/`h4` with `.mw-headline` (`sectionize()`). Each
  section has a `path` such as `["Cars", "Series 6 Update", "Notable Vehicles"]`.
- `sectionKind(path[0])`:
  - `Cars` → regular car groups. Each sub-heading becomes its own group ("Available at
    Launch", "Series 3 Update", ...). A table directly under "Cars" becomes a group titled "Cars".
  - `Trivia` → `<ul><li>` items become `loc.trivia`.
  - Contains `Parts List` / `Price Breakdown` → each `h3` is one car's parts list. The `h3`
    may end with a PI like `(B 600)` to tell variants apart. An `h4` "Tuning" under it holds
    the tuning table.
  - `Notes`, `References`, `Gallery` → ignored, except gallery items, which are collected
    from every section.
  - **Anything else** with car tables (for example "Series 3: Italian Exotics Dealership")
    is an **event** group. Event groups are collapsed and left out of progress by default.
- A group is **notable** if any heading in its path contains "Notable".
- A **car table** is any table whose header row has both a `Name` column and a
  `Performance Index`/`PI` column. Columns are mapped by `<abbr title>` or header text
  (`CAR_COLUMNS`). Blank headers fall back to the template order (`DEFAULT_ORDER`). Rows
  with fewer than 8 `<td>` are skipped (the wiki has some empty placeholder tables).
- Cell formats:
  - Name: an `<a title="Wiki Title">Display</a>`, then `<small>Category</small>`.
  - Price: `83,070 CR<br><small>35% Discount</small>`.
  - PI: a `<td class="ind ind-hor-s1" data-sort-value="720">S1 720</td>`.
  - Footnotes: `sup.reference` links to `li#cite_note-*`. Their text goes into `car.notes`.
- Images: `img[data-image-key]` with the real URL in the parent `<a href>` or in
  `data-src` (lazy loading). The map is the image whose key contains `AftermarketCarMap`.
  The location photo contains `AftermarketCarLocation` (overview and banner shots are skipped).
- Gallery: `.wikia-gallery-item`, with the caption in `.lightbox-caption`. An optional
  `<small>` note ("Modified", "Modified, A 671 variant") is used for matching.

### Matching modified cars to parts lists (`partsScore`)
Names are compared after normalising (case, accents and punctuation removed), and then
again with parentheses removed. "Subaru Legacy RS" matches "Subaru LEGACY RS", and
"Mini Cooper S" matches "MINI Cooper S (1965)". A PI in the heading must equal the car's
PI. A parts list whose FINAL PRICE equals the car's price within 2 CR gets a large bonus,
which separates variants such as the three Honda S2000s. The same location is searched
first, then every location.

## When the wiki layout changes: playbook

1. Run `npm run check-wiki -- --force`. It lists every location with its groups and then
   the problems it found. Lines marked `(info only)` are known inconsistencies in the wiki
   itself (for example a typo in a FINAL PRICE) and are not parser bugs.
2. Download the raw HTML of a failing page to compare against the contract above:
   `https://forza.fandom.com/api.php?action=parse&page=Forza_Horizon_6/Cars/Aftermarket/SOT1&prop=text&format=json&formatversion=2`
   The cached copy is also in `%APPDATA%/Aftermarket Tracker/cache/pages/SOT1.html`.
3. Fix `parser.js` and keep the changes local to it. Prefer matching on meaning (header
   text, abbr titles, heading words) over position.
4. **Bump `PARSER_VERSION`.**
5. Run `npm run check-wiki` again until it exits 0, then compare one location against the
   wiki with `--dump <CODE>`.
6. Check the UI with the screenshot hook (see Commands), then rebuild with `npm run dist`.

Typical changes and where to fix them:
- A new column in the car tables → add it to `CAR_COLUMNS` (and `DEFAULT_ORDER` if it is
  part of the template), then show it in `carRow()` / `renderCar()` in `app.js`.
- A renamed section (for example "Cars" → "Spawns") → `sectionKind()`.
- A new location-code pattern → `LOCATION_CODE_RE`.
- The index page moved or was renamed → `INDEX_PAGE` / `LOCATION_PREFIX` in parser.js.
  If it moved, `LOCATIONS_CATEGORY` in wiki.js may need the same change.

## Conventions

- Plain CommonJS in the main process and vanilla JS in the renderer, with no build step.
  Keep it that way unless there is a strong reason.
- The renderer must not use `innerHTML` with wiki text. Use the `el()` helper, which sets
  `textContent`.
- The renderer is sandboxed (`contextIsolation`, `sandbox`, CSP). New main-process
  features go through IPC in `preload.js`.
- Be polite to Fandom: a fixed User-Agent, at most 4 concurrent page downloads, and only
  pages whose revision changed.
