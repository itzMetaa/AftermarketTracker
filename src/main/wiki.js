'use strict';
// Talks to the Forza wiki's MediaWiki API, keeps a raw-HTML copy of every page on disk,
// and only re-downloads pages whose revision (or render timestamp) changed.

const fs = require('fs');
const path = require('path');
const P = require('./parser');

const API_URL = `${P.WIKI_ORIGIN}/api.php`;
const USER_AGENT = 'AftermarketTracker/1.0 (personal Forza Horizon 6 collection tracker)';
const LOCATIONS_CATEGORY = 'Category:Aftermarket Car Locations (FH6)';
const FETCH_CONCURRENCY = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toTitle = (s) => s.replace(/_/g, ' ');

async function api(params, retries = 2) {
  const url = `${API_URL}?${new URLSearchParams({ ...params, format: 'json', formatversion: '2' })}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${params.action}`);
      const json = await res.json();
      if (json.error) throw new Error(`${json.error.code}: ${json.error.info}`);
      return json;
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
}

/** { [title]: { revid, touched, missing } } for up to any number of titles. */
async function pageInfo(titles) {
  const out = {};
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const json = await api({ action: 'query', prop: 'info', titles: batch.join('|') });
    const normalized = Object.fromEntries((json.query.normalized || []).map((n) => [n.to, n.from]));
    for (const p of json.query.pages || []) {
      const key = normalized[p.title] ? toTitle(normalized[p.title]) : p.title;
      out[key] = { revid: p.lastrevid || null, touched: p.touched || null, missing: !!p.missing };
    }
  }
  return out;
}

async function categoryCodes() {
  const codes = [];
  let cont = {};
  do {
    const json = await api({ action: 'query', list: 'categorymembers', cmtitle: LOCATIONS_CATEGORY,
      cmlimit: '500', cmtype: 'page', ...cont });
    for (const m of json.query.categorymembers || []) {
      const t = m.title.replace(/ /g, '_');
      if (!t.startsWith(P.LOCATION_PREFIX)) continue;
      const code = t.slice(P.LOCATION_PREFIX.length);
      if (P.LOCATION_CODE_RE.test(code)) codes.push(code);
    }
    cont = json.continue || null;
  } while (cont);
  return codes;
}

async function fetchPage(page) {
  const json = await api({ action: 'parse', page, prop: 'text|displaytitle|revid',
    disableeditsection: '1', disablelimitreport: '1' });
  return { html: json.parse.text, displayTitle: json.parse.displaytitle, revid: json.parse.revid };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

class WikiSync {
  constructor(cacheDir) {
    this.pagesDir = path.join(cacheDir, 'pages');
    this.metaPath = path.join(cacheDir, 'pages.json');
    this.dataPath = path.join(cacheDir, 'data.json');
    fs.mkdirSync(this.pagesDir, { recursive: true });
    this.meta = readJson(this.metaPath, { index: null, locations: {} });
    this.running = null;
  }

  /** Last built data set, rebuilt from raw HTML if the parser changed since. */
  loadData() {
    const data = readJson(this.dataPath, null);
    if (data && data.parserVersion === P.PARSER_VERSION) return data;
    if (this.meta.index) {
      try { return this.build(); } catch (err) { console.error('Rebuild failed', err); }
    }
    return null;
  }

  sync(opts = {}) {
    if (!this.running) this.running = this._sync(opts).finally(() => { this.running = null; });
    return this.running;
  }

  async _sync({ force = false, onProgress = () => {} }) {
    const errors = [];
    onProgress({ phase: 'Checking the wiki for changes…' });

    const indexTitle = toTitle(P.INDEX_PAGE);
    const indexInfo = (await pageInfo([indexTitle]))[indexTitle] || {};
    const indexChanged = force || !this.meta.index || !this.hasRaw('_index')
      || this.meta.index.revid !== indexInfo.revid || this.meta.index.touched !== indexInfo.touched;
    if (indexChanged) {
      onProgress({ phase: 'Downloading location list…' });
      const page = await fetchPage(P.INDEX_PAGE);
      this.writeRaw('_index', page.html);
      this.meta.index = { revid: indexInfo.revid, touched: indexInfo.touched };
    }

    const index = P.parseIndexPage(this.readRaw('_index'));
    let codes = index.map((l) => l.code);
    try {
      for (const c of await categoryCodes()) if (!codes.includes(c)) codes.push(c);
    } catch (err) {
      errors.push(`Category lookup failed: ${err.message}`);
    }

    const titles = codes.map((c) => toTitle(P.LOCATION_PREFIX + c));
    const infos = await pageInfo(titles);
    codes = codes.filter((c) => !infos[toTitle(P.LOCATION_PREFIX + c)]?.missing);

    const stale = codes.filter((c) => {
      const info = infos[toTitle(P.LOCATION_PREFIX + c)] || {};
      const m = this.meta.locations[c];
      return force || !m || !this.hasRaw(c) || m.revid !== info.revid || m.touched !== info.touched;
    });

    let done = 0;
    await mapLimit(stale, FETCH_CONCURRENCY, async (code) => {
      try {
        const page = await fetchPage(P.LOCATION_PREFIX + code);
        const info = infos[toTitle(P.LOCATION_PREFIX + code)] || {};
        this.writeRaw(code, page.html);
        this.meta.locations[code] = { revid: info.revid ?? page.revid, touched: info.touched,
          displayTitle: page.displayTitle };
      } catch (err) {
        errors.push(`${code}: ${err.message}`);
      }
      onProgress({ phase: `Downloading location pages… ${++done}/${stale.length}`, done, total: stale.length });
    });

    this.meta.codes = codes;
    writeJson(this.metaPath, this.meta);
    onProgress({ phase: 'Reading pages…' });
    const data = this.build();
    return { data, updated: stale.filter((c) => this.meta.locations[c]), errors };
  }

  /** Parse every cached page and link cars to parts lists and gallery photos. */
  build() {
    const index = P.parseIndexPage(this.readRaw('_index'));
    const codes = this.meta.codes || index.map((l) => l.code);
    const byCode = Object.fromEntries(index.map((l) => [l.code, l]));
    const regionOfPrefix = {};
    for (const l of index) regionOfPrefix[l.code.replace(/\d+$/, '')] ??= l.region;

    const locations = [];
    for (const code of codes) {
      if (!this.hasRaw(code)) continue;
      const meta = this.meta.locations[code] || {};
      const loc = P.parseLocationPage(this.readRaw(code), { code, displayTitle: meta.displayTitle });
      const idx = byCode[code];
      loc.region = idx?.region || regionOfPrefix[code.replace(/\d+$/, '')] || 'Other';
      loc.mapImage = loc.mapImage || idx?.mapImage || null;
      loc.wikiUrl = `${P.WIKI_ORIGIN}/wiki/${encodeURI(P.LOCATION_PREFIX + code)}`;
      locations.push(loc);
    }

    const allParts = locations.flatMap((l) => l.parts);
    for (const loc of locations) {
      for (const group of loc.groups) {
        for (const car of group.cars) {
          if (car.modified) {
            const parts = P.bestParts(car, loc.parts) || P.bestParts(car, allParts);
            if (parts) car.parts = parts;
          }
          car.photos = P.galleryMatches(car, loc.gallery);
          car.wikiUrl = car.wikiPath ? `${P.WIKI_ORIGIN}/wiki/${encodeURI(car.wikiPath)}` : null;
        }
      }
      delete loc.parts; // now attached to the cars that use them
      delete loc.gallery;
    }

    const data = { parserVersion: P.PARSER_VERSION, builtAt: new Date().toISOString(), locations };
    writeJson(this.dataPath, data);
    return data;
  }

  rawPath(code) { return path.join(this.pagesDir, `${code}.html`); }
  hasRaw(code) { return fs.existsSync(this.rawPath(code)); }
  readRaw(code) { return fs.readFileSync(this.rawPath(code), 'utf8'); }
  writeRaw(code, html) { writeFileAtomic(this.rawPath(code), html); }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  writeFileAtomic(file, JSON.stringify(value));
}

function writeFileAtomic(file, contents) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

module.exports = { WikiSync, readJson, writeJson, writeFileAtomic, USER_AGENT };
