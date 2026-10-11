'use strict';
// Turns rendered wiki HTML (from the MediaWiki `action=parse` API) into plain data.
// Everything that depends on the wiki's page layout lives in this file.
// See AGENTS.md ("Wiki layout contract") before changing anything here.

const cheerio = require('cheerio');

// Bump whenever the output shape or parsing rules change: cached pages are re-parsed
// from the raw HTML stored on disk instead of being re-downloaded.
const PARSER_VERSION = 3;

const WIKI_ORIGIN = 'https://forza.fandom.com';
const INDEX_PAGE = 'Forza_Horizon_6/Cars/Aftermarket';
const LOCATION_PREFIX = 'Forza_Horizon_6/Cars/Aftermarket/';
const LOCATION_CODE_RE = /^[A-Z]{2,4}\d{1,2}$/;

// Car table columns, keyed by the header's <abbr title> or text.
const CAR_COLUMNS = {
  image: /^image$/i,
  year: /^year$/i,
  name: /^name$/i,
  modified: /^(modified|m)$/i,
  price: /^price$/i,
  speed: /^(speed|s)$/i,
  handling: /^(handling|h)$/i,
  acceleration: /^(acceleration|a)$/i,
  launch: /^(launch|l)$/i,
  braking: /^(braking|b)$/i,
  offroad: /^(offroad|o)$/i,
  pi: /^(performance index|pi)$/i,
  flavor: /^flavou?r(\s*text)?$/i,
};
// Column order of the FH6AftermarketLocation template; used when a header cell is blank.
const DEFAULT_ORDER = ['image', 'year', 'name', 'modified', 'price', 'speed', 'handling',
  'acceleration', 'launch', 'braking', 'offroad', 'pi', 'flavor'];
const STAT_KEYS = ['speed', 'handling', 'acceleration', 'launch', 'braking', 'offroad'];

const PI_RE = /\b(D|C|B|A|S1|S2|R|X)\s*(\d{3,4})\b/i;

// ---------------------------------------------------------------- helpers

function clean(text) {
  return String(text || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/** Visible text of an element without footnote markers or edit links. */
function textOf($, el) {
  const c = $(el).clone();
  c.find('sup.reference, .mw-editsection, style, script, noscript').remove();
  c.find('br').replaceWith(' ');
  return clean(c.text());
}

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

function stripParens(s) {
  return String(s || '').replace(/\([^)]*\)/g, ' ');
}

function parseNumber(text) {
  const m = String(text || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Strip the scaling part of a static.wikia image URL so it points at the original. */
function originalImageUrl(url) {
  if (!url) return null;
  if (url.startsWith('//')) url = 'https:' + url;
  if (!/^https?:\/\/static\.wikia\.nocookie\.net\//.test(url)) return null;
  return url.replace(/\/revision\/latest\/[^?]*/, '/revision/latest');
}

/** {key, url} for the first image inside `scope`, or null. */
function imageIn($, scope) {
  return imageOf($, $(scope).find('img').first());
}

/** {key, url} for an <img> element, preferring the original-size file URL. */
function imageOf($, img) {
  img = $(img);
  if (!img.length) return null;
  const candidates = [img.closest('a').attr('href'), img.attr('data-src'), img.attr('src')];
  for (const c of candidates) {
    const url = originalImageUrl(c);
    if (url) return { key: img.attr('data-image-key') || img.attr('data-image-name') || null, url };
  }
  return null;
}

function linkTitleFromHref(href) {
  if (!href) return null;
  const m = href.match(/^\/wiki\/([^?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function parsePi(text) {
  const m = String(text || '').match(PI_RE);
  return m ? { cls: m[1].toUpperCase(), value: Number(m[2]) } : null;
}

// ------------------------------------------------------------ sectioning

/**
 * Flatten the article into sections. Each heading (h2-h4) starts a new section whose
 * `path` is the list of enclosing heading titles, e.g. ["Cars", "Series 6 Update"].
 * Tables, paragraphs, lists and gallery items are attached to the section they follow.
 * Content before the first heading lands in a section with an empty path (the intro).
 */
function sectionize($) {
  const root = $('.mw-parser-output').first().length ? $('.mw-parser-output').first() : $.root();
  const sections = [{ level: 1, title: '', path: [], items: [] }];
  const stack = [];

  root.find('h2, h3, h4, table, p, ul, .wikia-gallery-item, figure').each((_, el) => {
    const $el = $(el);
    const tag = el.tagName.toLowerCase();
    // Skip things nested inside tables/galleries/navboxes/TOC; they belong to their container.
    if ($el.parents('table, #toc, .toc, .navbox, .wikia-gallery-item').length) return;
    if (/^h[234]$/.test(tag)) {
      if ($el.attr('id') === 'mw-toc-heading') return;
      const level = Number(tag[1]);
      const headline = $el.find('.mw-headline').first();
      const title = textOf($, headline.length ? headline : $el);
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title });
      sections.push({ level, title, path: stack.map((s) => s.title), items: [] });
      return;
    }
    const cur = sections[sections.length - 1];
    if (tag === 'table') {
      if ($el.is('.navbox') || $el.find('.navbox').length) return;
      cur.items.push({ type: 'table', el });
    } else if (tag === 'p') {
      const text = textOf($, el);
      if (text) cur.items.push({ type: 'p', text });
    } else if (tag === 'ul') {
      const items = $el.children('li').map((__, li) => textOf($, li)).get().filter(Boolean);
      if (items.length) cur.items.push({ type: 'ul', items });
    } else if (tag === 'figure') {
      const image = imageIn($, el);
      if (image) cur.items.push({ type: 'figure', image });
    } else {
      cur.items.push({ type: 'gallery', el });
    }
  });
  return sections;
}

// --------------------------------------------------------------- car tables

function headerLabels($, table) {
  const firstRow = $(table).find('tr').first();
  return firstRow.children('th').map((_, th) => {
    const abbr = $(th).find('abbr').attr('title');
    return clean(abbr || textOf($, th));
  }).get();
}

function isCarTable($, table) {
  const labels = headerLabels($, table);
  const hasName = labels.some((l) => CAR_COLUMNS.name.test(l));
  const hasPi = labels.some((l) => CAR_COLUMNS.pi.test(l));
  return hasName && hasPi;
}

function columnMap(labels) {
  return labels.map((label, i) => {
    for (const [key, re] of Object.entries(CAR_COLUMNS)) if (re.test(label)) return key;
    return label === '' ? DEFAULT_ORDER[i] || null : null;
  });
}

function footnotes($, cell) {
  const notes = [];
  $(cell).find('sup.reference a[href^="#"]').each((_, a) => {
    const id = $(a).attr('href').slice(1);
    const li = $(`li[id="${id}"]`);
    const text = textOf($, li.find('.reference-text').length ? li.find('.reference-text') : li);
    if (text && !notes.includes(text)) notes.push(text);
  });
  return notes;
}

function parseCarRow($, tr, cols) {
  const tds = $(tr).children('td');
  if (tds.length < 8) return null;
  const car = { notes: [] };
  tds.each((i, td) => {
    const key = cols[i];
    if (!key) return;
    const $td = $(td);
    car.notes.push(...footnotes($, td));
    switch (key) {
      case 'image': car.image = imageIn($, td); break;
      case 'year': car.year = parseNumber(textOf($, td)); break;
      case 'name': {
        const a = $td.find('a').first();
        const small = $td.find('small');
        const nameEl = $td.clone();
        nameEl.find('small, sup.reference').remove();
        car.name = textOf($, nameEl) || textOf($, a);
        car.title = clean(a.attr('title')) || car.name;
        car.wikiPath = linkTitleFromHref(a.attr('href'));
        car.category = small.length ? textOf($, small) : null;
        break;
      }
      case 'modified': car.modified = /^y/i.test(textOf($, td)); break;
      case 'price': {
        const small = $td.find('small');
        const discount = small.length ? textOf($, small) : '';
        const main = $td.clone();
        main.find('small, sup.reference').remove();
        car.price = parseNumber(textOf($, main));
        car.discount = (discount.match(/\d+\s*%/) || [null])[0];
        break;
      }
      case 'pi': {
        const sortValue = parseNumber($td.attr('data-sort-value'));
        const pi = parsePi(textOf($, td));
        car.pi = pi || (sortValue ? { cls: null, value: sortValue } : null);
        break;
      }
      case 'flavor': car.flavor = textOf($, td); break;
      default:
        if (STAT_KEYS.includes(key)) {
          car.stats = car.stats || {};
          car.stats[key] = parseNumber(textOf($, td));
        }
    }
  });
  if (!car.name) return null;
  car.modified = !!car.modified;
  car.stats = car.stats || {};
  car.key = carKey(car);
  return car;
}

/** Identity used for the collection checkboxes: same car + same build = same key. */
function carKey(car) {
  const pi = car.pi ? `${car.pi.cls || ''}${car.pi.value}` : '?';
  return `${car.title}|${car.modified ? 'M' : 'S'}|${pi}`;
}

function parseCarTable($, table) {
  const cols = columnMap(headerLabels($, table));
  const cars = [];
  $(table).find('tr').each((_, tr) => {
    const car = parseCarRow($, tr, cols);
    if (car) cars.push(car);
  });
  return cars;
}

// ----------------------------------------------------------- generic tables

/** Header + rows of a simple table (parts lists, tuning), keeping colspans and bold rows. */
function parseGenericTable($, table) {
  const headers = $(table).find('tr').first().children('th').map((_, th) => textOf($, th)).get();
  const rows = [];
  $(table).find('tr').each((_, tr) => {
    const tds = $(tr).children('td');
    if (!tds.length) return;
    const cells = tds.map((__, td) => ({
      text: textOf($, td),
      colspan: Number($(td).attr('colspan')) || 1,
    })).get();
    const bold = tds.toArray().every((td) => !textOf($, td) || $(td).find('b, strong').length > 0);
    const span = cells.reduce((n, c) => n + c.colspan, 0);
    rows.push({ cells, bold, section: cells.length === 1 && span >= Math.max(headers.length, 2) });
  });
  return { headers, rows };
}

function finalPriceOf(table) {
  for (const row of table.rows) {
    if (/final\s*price/i.test(row.cells[0].text)) return parseNumber(row.cells[row.cells.length - 1].text);
  }
  return null;
}

// --------------------------------------------------------------- matching

function nameMatchLevel(heading, car) {
  const names = [car.title, car.name].filter(Boolean);
  if (names.some((n) => norm(n) === norm(heading))) return 3;
  if (names.some((n) => norm(stripParens(n)) === norm(stripParens(heading)))) return 2;
  return 0;
}

/** Score how well a parts-list section fits a car. 0 = no match. */
function partsScore(parts, car) {
  if (!car.modified) return 0;
  const level = nameMatchLevel(parts.name, car);
  if (!level) return 0;
  if (parts.pi && car.pi && parts.pi.value !== car.pi.value) return 0;
  let score = level;
  if (parts.pi && car.pi && parts.pi.value === car.pi.value) score += 2;
  if (parts.finalPrice != null && car.price != null) {
    score += Math.abs(parts.finalPrice - car.price) <= 2 ? 4 : -1;
  }
  return score;
}

function bestParts(car, candidates) {
  let best = null;
  let bestScore = 1;
  for (const p of candidates) {
    const s = partsScore(p, car);
    if (s > bestScore) { best = p; bestScore = s; }
  }
  return best;
}

function galleryMatches(car, gallery) {
  return gallery.filter((g) => {
    if (!nameMatchLevel(g.name, car)) return false;
    const notePi = parsePi(g.note);
    if (notePi && car.pi && notePi.value !== car.pi.value) return false;
    if (/modified/i.test(g.note) && !car.modified) return false;
    return true;
  }).map((g) => ({ url: g.url, caption: g.note ? `${g.name} (${g.note})` : g.name }));
}

// ------------------------------------------------------------ page parsers

function sectionKind(path) {
  const top = path[0] || '';
  if (/^cars$/i.test(top)) return 'cars';
  if (/trivia/i.test(top)) return 'trivia';
  if (/parts\s*list|price\s*breakdown/i.test(top)) return 'parts';
  if (/^(notes|references|gallery)$/i.test(top)) return 'other';
  return 'event'; // e.g. "Series 3: Italian Exotics Dealership"
}

/**
 * Parse one location page (e.g. Forza_Horizon_6/Cars/Aftermarket/SOT1).
 * Returns { code, name, displayTitle, mapImage, photo, intro, groups, trivia, parts, gallery }.
 */
function parseLocationPage(html, { code, displayTitle } = {}) {
  const $ = cheerio.load(html);
  const sections = sectionize($);
  const loc = {
    code,
    name: clean(String(displayTitle || '').replace(/<[^>]*>/g, '').replace(/^Aftermarket Cars:\s*/i, '')) || code,
    mapImage: null,
    photo: null,
    intro: [],
    groups: [],
    trivia: [],
    parts: [],
    gallery: [],
    warnings: [],
  };

  // Images: the wiki puts "FH6 AftermarketCarMap XXX.png" and "FH6 AftermarketCarLocation XXX.jpg"
  // at the top of every location page.
  $('img[data-image-key]').each((_, img) => {
    const key = $(img).attr('data-image-key');
    const image = imageOf($, img);
    if (!image) return;
    if (!loc.mapImage && /AftermarketCarMap/i.test(key)) loc.mapImage = image;
    if (!loc.photo && /AftermarketCarLocation/i.test(key) && !/overview|banner/i.test(key)) loc.photo = image;
  });

  let currentParts = null;
  for (const sec of sections) {
    const kind = sec.path.length ? sectionKind(sec.path) : 'intro';
    for (const item of sec.items) {
      if (item.type === 'gallery') {
        const image = imageIn($, item.el);
        const captionEl = $(item.el).find('.lightbox-caption');
        const note = textOf($, captionEl.find('small'));
        const capClone = captionEl.clone();
        capClone.find('small').remove();
        if (image) loc.gallery.push({ url: image.url, name: textOf($, capClone), note, path: sec.path });
      }
    }

    if (kind === 'intro') {
      loc.intro.push(...sec.items.filter((i) => i.type === 'p').map((i) => i.text));
      continue;
    }

    if (kind === 'cars' || kind === 'event') {
      let group = null;
      const paragraphs = [];
      for (const item of sec.items) {
        if (item.type === 'p') paragraphs.push(item.text);
        if (item.type === 'ul') paragraphs.push(...item.items);
        if (item.type !== 'table' || !isCarTable($, item.el)) continue;
        const cars = parseCarTable($, item.el);
        if (!cars.length) continue;
        if (!group) {
          const subPath = kind === 'cars' ? sec.path.slice(1) : sec.path;
          group = {
            id: sec.path.join(' > '),
            title: subPath.length ? subPath[subPath.length - 1] : 'Cars',
            context: subPath.slice(0, -1),
            event: kind === 'event',
            notable: sec.path.some((p) => /notable/i.test(p)),
            intro: [],
            cars: [],
          };
          loc.groups.push(group);
        }
        group.cars.push(...cars);
      }
      if (group) group.intro = paragraphs;
      continue;
    }

    if (kind === 'trivia') {
      for (const item of sec.items) {
        if (item.type === 'ul') loc.trivia.push(...item.items);
        if (item.type === 'p') loc.trivia.push(item.text);
      }
      continue;
    }

    if (kind === 'parts') {
      if (sec.level === 3) {
        const m = sec.title.match(/\(\s*(D|C|B|A|S1|S2|R|X)\s*(\d{3,4})\s*\)\s*$/i);
        currentParts = {
          heading: sec.title,
          name: clean(m ? sec.title.slice(0, m.index) : sec.title),
          pi: m ? { cls: m[1].toUpperCase(), value: Number(m[2]) } : null,
          location: code,
          table: null,
          tuning: null,
          notes: [],
        };
        loc.parts.push(currentParts);
      }
      if (!currentParts) continue;
      const isTuning = sec.level >= 4 && /tun/i.test(sec.title);
      for (const item of sec.items) {
        if (item.type === 'table') {
          const t = parseGenericTable($, item.el);
          if (isTuning) currentParts.tuning = currentParts.tuning || t;
          else if (!currentParts.table) {
            currentParts.table = t;
            currentParts.finalPrice = finalPriceOf(t);
            currentParts.notes.push(...footnotes($, item.el));
          }
        } else if (item.type === 'p') {
          currentParts.notes.push(item.text);
        }
      }
    }
  }

  loc.parts = loc.parts.filter((p) => p.table);
  if (!loc.groups.length) loc.warnings.push('No car tables found');
  if (!loc.mapImage) loc.warnings.push('No map image found');
  return loc;
}

/**
 * Parse the index page (Forza_Horizon_6/Cars/Aftermarket): ordered list of
 * { code, region, mapImage } from the "Locations" section's region tables.
 */
function parseIndexPage(html) {
  const $ = cheerio.load(html);
  const sections = sectionize($);
  const result = [];
  const seen = new Set();
  const add = (code, region, mapImage) => {
    if (seen.has(code)) return;
    seen.add(code);
    result.push({ code, region, mapImage: mapImage || null });
  };

  for (const sec of sections) {
    if (!/^locations$/i.test(sec.path[0] || '')) continue;
    const region = clean((sec.path[1] || 'Other').replace(/\s+region$/i, ''));
    for (const item of sec.items) {
      if (item.type !== 'table') continue;
      let lastImage = null; // map cells can span several rows (rowspan)
      $(item.el).find('tr').each((_, tr) => {
        const img = imageIn($, tr);
        if (img) lastImage = img;
        $(tr).find('a[href]').each((__, a) => {
          const title = linkTitleFromHref($(a).attr('href'));
          if (!title || !title.startsWith(LOCATION_PREFIX)) return;
          const code = title.slice(LOCATION_PREFIX.length);
          if (LOCATION_CODE_RE.test(code)) add(code, region, lastImage);
        });
      });
    }
  }
  return result;
}

module.exports = {
  PARSER_VERSION,
  WIKI_ORIGIN,
  INDEX_PAGE,
  LOCATION_PREFIX,
  LOCATION_CODE_RE,
  parseIndexPage,
  parseLocationPage,
  bestParts,
  galleryMatches,
  carKey,
  norm,
};
