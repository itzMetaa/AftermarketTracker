'use strict';
/* global tracker */

// ------------------------------------------------------------------ utils

const $ = (sel, root = document) => root.querySelector(sel);

/** Tiny element builder. Text is always set via textContent (wiki text is untrusted). */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** wimg:// URL for a wiki image, optionally scaled down on the wiki side. */
function wimg(url, width) {
  if (!url) return '';
  const u = width ? url.replace('/revision/latest', `/revision/latest/scale-to-width-down/${width}`) : url;
  return `wimg://img/?u=${encodeURIComponent(u)}`;
}

function img(url, width, props = {}) {
  if (!url) return el('div', { class: `img-missing ${props.class || ''}` });
  const node = el('img', { src: wimg(url, width), loading: 'lazy', decoding: 'async', alt: '', ...props });
  node.addEventListener('error', () => node.classList.add('broken'), { once: true });
  return node;
}

const fmtCr = (n) => (n == null ? '—' : `${Math.round(n).toLocaleString('en-US')} CR`);
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

const PI_CLASSES = ['D', 'C', 'B', 'A', 'S1', 'S2', 'R', 'X'];
function piBadge(pi, big) {
  if (!pi) return el('span', { class: 'pi none', text: '—' });
  const cls = PI_CLASSES.includes(pi.cls) ? pi.cls : 'unknown';
  return el('span', { class: `pi pi-${cls.toLowerCase()}${big ? ' big' : ''}` },
    el('span', { class: 'pi-cls', text: pi.cls || '?' }), el('span', { class: 'pi-val', text: pi.value }));
}

function bar(done, total, extra = '') {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return el('div', { class: `bar ${extra}${total && done >= total ? ' full' : ''}` },
    el('div', { class: 'fill', style: `width:${pct}%` }));
}

// ------------------------------------------------------------------ state

let data = null; // { builtAt, locations: [...] }
let state = null; // persisted in collection.json
let saveTimer = null;
const view = { code: null, carKey: null, newKeys: new Set(), scroll: 0 };

const defaults = () => ({
  version: 1,
  checked: {}, // carKey -> timestamp (used when linkIdentical)
  checkedLoc: {}, // "CODE|carKey" -> timestamp (used otherwise)
  known: null, // CODE -> [carKey] the user has already seen (for NEW badges)
  settings: { linkIdentical: true, countEvents: false },
  ui: { filter: 'all' },
});

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => tracker.setState(state), 250);
}

const locByCode = (code) => data && data.locations.find((l) => l.code === code);
const allCars = (loc) => loc.groups.flatMap((g) => g.cars);

function isChecked(code, car) {
  return state.settings.linkIdentical ? !!state.checked[car.key] : !!state.checkedLoc[`${code}|${car.key}`];
}

function setChecked(code, car, on) {
  const map = state.settings.linkIdentical ? state.checked : state.checkedLoc;
  const key = state.settings.linkIdentical ? car.key : `${code}|${car.key}`;
  if (on) map[key] = Date.now();
  else delete map[key];
  saveState();
}

/** Unique cars of a location that count toward its progress. */
function countedCars(loc) {
  const seen = new Map();
  for (const g of loc.groups) {
    if (g.event && !state.settings.countEvents) continue;
    for (const car of g.cars) if (!seen.has(car.key)) seen.set(car.key, car);
  }
  return [...seen.values()];
}

function progress(loc) {
  const cars = countedCars(loc);
  return { done: cars.filter((c) => isChecked(loc.code, c)).length, total: cars.length };
}

function overallProgress() {
  if (state.settings.linkIdentical) {
    const keys = new Set(data.locations.flatMap((l) => countedCars(l).map((c) => c.key)));
    const done = [...keys].filter((k) => state.checked[k]).length;
    return { done, total: keys.size, unit: 'unique cars' };
  }
  let done = 0;
  let total = 0;
  for (const l of data.locations) { const p = progress(l); done += p.done; total += p.total; }
  return { done, total, unit: 'cars' };
}

/** Car keys at a location the user hasn't seen yet. `null` = whole location is new. */
function unseen(loc) {
  const known = state.known && state.known[loc.code];
  if (!known) return null;
  const set = new Set(known);
  return [...new Set(allCars(loc).map((c) => c.key))].filter((k) => !set.has(k));
}

function markSeen(loc) {
  state.known[loc.code] = [...new Set(allCars(loc).map((c) => c.key))];
  saveState();
}

/** First run: everything currently on the wiki counts as already seen. */
function ensureKnown() {
  if (state.known || !data) return;
  state.known = {};
  for (const loc of data.locations) state.known[loc.code] = [...new Set(allCars(loc).map((c) => c.key))];
  saveState();
}

// ------------------------------------------------------------------ grid

function matchesSearch(loc, q) {
  if (!q) return true;
  if (fold(`${loc.code} ${loc.name} ${loc.region}`).includes(q)) return true;
  return allCars(loc).some((c) => fold(`${c.name} ${c.title} ${c.year}`).includes(q));
}

function renderGrid() {
  const grid = $('#grid');
  grid.replaceChildren();
  if (!data) return;

  const q = fold($('#search').value.trim());
  const filter = state.ui.filter;
  const regions = new Map();
  for (const loc of data.locations) {
    if (!regions.has(loc.region)) regions.set(loc.region, []);
    regions.get(loc.region).push(loc);
  }

  let shown = 0;
  for (const [region, locs] of regions) {
    let rDone = 0;
    let rTotal = 0;
    const cards = [];
    for (const loc of locs) {
      const p = progress(loc);
      rDone += p.done;
      rTotal += p.total;
      const fresh = unseen(loc);
      const complete = p.total > 0 && p.done >= p.total;
      if (!matchesSearch(loc, q)) continue;
      if (filter === 'complete' && !complete) continue;
      if (filter === 'incomplete' && complete) continue;
      if (filter === 'new' && !(fresh === null || fresh.length)) continue;
      cards.push(card(loc, p, fresh, complete));
    }
    if (!cards.length) continue;
    shown += cards.length;
    grid.append(el('section', { class: 'region' },
      el('div', { class: 'region-head' },
        el('h2', { text: region }),
        el('span', { class: 'region-count', text: `${rDone} / ${rTotal}` }),
        bar(rDone, rTotal, 'region-bar')),
      el('div', { class: 'cards' }, cards)));
  }
  if (!shown) grid.append(el('div', { class: 'empty', text: 'No locations match.' }));

  const o = overallProgress();
  const locsDone = data.locations.filter((l) => { const p = progress(l); return p.total && p.done >= p.total; }).length;
  $('#overallText').textContent = `${o.done} / ${o.total} ${o.unit}`;
  $('#overallSub').textContent = `· ${locsDone} / ${data.locations.length} locations complete`;
  $('#overallBar').style.width = `${o.total ? (o.done / o.total) * 100 : 0}%`;
}

function card(loc, p, fresh, complete) {
  let badge = null;
  if (fresh === null) badge = el('span', { class: 'badge-new', text: 'NEW LOCATION' });
  else if (fresh.length) badge = el('span', { class: 'badge-new', text: `+${fresh.length} NEW` });
  return el('button', { class: `card${complete ? ' complete' : ''}`, onclick: () => openLocation(loc.code) },
    el('div', { class: 'card-img' },
      img(loc.mapImage && loc.mapImage.url, 400),
      el('span', { class: 'card-code', text: loc.code }),
      badge,
      complete ? el('span', { class: 'card-check', text: '✓' }) : null),
    el('div', { class: 'card-body' },
      el('div', { class: 'card-row' },
        el('span', { class: 'card-name', text: loc.name }),
        el('span', { class: 'card-count', text: `${p.done}/${p.total}` })),
      bar(p.done, p.total)));
}

// ------------------------------------------------------------------ modal

function openModal() {
  $('#modal').classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeModal() {
  $('#modal').classList.add('hidden');
  document.body.classList.remove('modal-open');
  view.code = null;
  view.carKey = null;
  renderGrid();
}

function openLocation(code) {
  const loc = locByCode(code);
  if (!loc) return;
  const fresh = unseen(loc);
  view.newKeys = new Set(fresh === null ? [] : fresh);
  view.code = code;
  view.carKey = null;
  view.scroll = 0;
  renderLocation();
  openModal();
  markSeen(loc);
}

function renderLocation() {
  const loc = locByCode(view.code);
  const panel = $('#modalPanel');
  if (!loc) { closeModal(); return; }
  const p = progress(loc);
  const q = fold($('#search').value.trim());

  const head = el('div', { class: 'loc-head' },
    el('div', { class: 'loc-images' },
      loc.photo ? el('button', { class: 'img-btn', onclick: () => lightbox(loc.photo.url) }, img(loc.photo.url, 640)) : null,
      loc.mapImage ? el('button', { class: 'img-btn', onclick: () => lightbox(loc.mapImage.url) }, img(loc.mapImage.url, 400)) : null),
    el('div', { class: 'loc-info' },
      el('div', { class: 'loc-kicker', text: `${loc.region} region` }),
      el('h1', {}, el('span', { class: 'loc-code', text: loc.code }), ' ', loc.name),
      el('div', { class: 'progress-row' }, bar(p.done, p.total, 'big'),
        el('span', { class: 'progress-text', text: `${p.done} / ${p.total} collected` })),
      loc.intro.length ? el('div', { class: 'loc-intro' }, loc.intro.map((t) => el('p', { text: t }))) : null,
      el('div', { class: 'loc-actions' },
        el('button', { class: 'btn ghost', onclick: () => tracker.openExternal(loc.wikiUrl), text: 'Open on wiki ↗' }))),
    el('button', { class: 'close-btn', title: 'Close (Esc)', onclick: closeModal, text: '×' }));

  const regular = loc.groups.filter((g) => !g.event);
  const events = loc.groups.filter((g) => g.event);
  const body = el('div', { class: 'loc-body' },
    regular.map((g) => groupSection(loc, g, q)),
    events.length ? el('details', { class: 'events', open: state.settings.countEvents || undefined },
      el('summary', {},
        el('span', { text: 'Past Evolving World events' }),
        el('small', { text: state.settings.countEvents ? 'counted toward progress' : 'not counted toward progress' })),
      events.map((g) => groupSection(loc, g, q))) : null,
    loc.trivia.length ? el('section', { class: 'trivia' },
      el('h3', { text: 'Trivia' }),
      el('ul', {}, loc.trivia.map((t) => el('li', { text: t })))) : null);

  panel.className = 'modal-panel loc-view';
  panel.replaceChildren(head, body);
  panel.scrollTop = view.scroll;
}

function groupSection(loc, group, q) {
  const titleParts = [...group.context, group.title];
  return el('section', { class: `group${group.notable ? ' notable' : ''}${group.event ? ' event' : ''}` },
    el('div', { class: 'group-head' },
      el('h3', {}, titleParts.map((t, i) => (i < titleParts.length - 1
        ? el('span', { class: 'crumb', text: `${t} › ` }) : t))),
      group.notable ? el('span', { class: 'chip notable', text: 'Not in Autoshow' }) : null,
      el('span', { class: 'group-count', text: `${group.cars.filter((c) => isChecked(loc.code, c)).length} / ${group.cars.length}` })),
    group.intro.length ? el('div', { class: 'group-intro' }, group.intro.map((t) => el('p', { text: t }))) : null,
    el('table', { class: 'cars' },
      el('thead', {}, el('tr', {},
        el('th', { class: 'c-check', title: 'Collected', text: '✓' }), el('th', { class: 'c-img' }), el('th', { class: 'c-year', text: 'Year' }),
        el('th', { class: 'c-name', text: 'Name' }), el('th', { class: 'c-mod', title: 'Modified', text: 'M' }), el('th', { class: 'c-price', text: 'Price' }),
        el('th', { class: 'c-pi', text: 'PI' }), el('th', { text: 'Flavor Text' }))),
      el('tbody', {}, group.cars.map((car) => carRow(loc, car, q)))));
}

function carRow(loc, car, q) {
  const checked = isChecked(loc.code, car);
  const hit = q && fold(`${car.name} ${car.title} ${car.year}`).includes(q);
  const box = el('input', { type: 'checkbox', checked: checked || undefined, title: 'Collected' });
  box.addEventListener('change', () => { setChecked(loc.code, car, box.checked); rememberScroll(); renderLocation(); });
  return el('tr', { class: `${checked ? 'collected' : ''}${hit ? ' hit' : ''}`, onclick: (e) => {
    if (e.target.closest('.c-check')) return;
    openCar(car.key);
  } },
  el('td', { class: 'c-check', onclick: (e) => { if (e.target !== box) { box.checked = !box.checked; box.dispatchEvent(new Event('change')); } } }, box),
  el('td', { class: 'c-img' }, img(car.image && car.image.url, 180)),
  el('td', { class: 'c-year', text: car.year || '' }),
  el('td', { class: 'c-name' },
    el('div', { class: 'car-name' }, car.name, view.newKeys.has(car.key) ? el('span', { class: 'badge-new small', text: 'NEW' }) : null),
    car.category ? el('div', { class: 'car-cat', text: car.category }) : null),
  el('td', { class: 'c-mod' }, car.modified ? el('span', { class: 'mod-tag', title: 'Modified', text: 'M' }) : el('span', { class: 'muted', text: '–' })),
  el('td', { class: 'c-price' }, el('div', { text: fmtCr(car.price) }), car.discount ? el('div', { class: 'discount', text: `${car.discount} off` }) : null),
  el('td', { class: 'c-pi' }, piBadge(car.pi)),
  el('td', { class: 'c-flavor', text: car.flavor || '' }));
}

function rememberScroll() {
  view.scroll = $('#modalPanel').scrollTop;
}

// ------------------------------------------------------------------ car view

const STATS = [['speed', 'Speed'], ['handling', 'Handling'], ['acceleration', 'Acceleration'],
  ['launch', 'Launch'], ['braking', 'Braking'], ['offroad', 'Offroad']];

function openCar(key) {
  rememberScroll();
  view.carKey = key;
  renderCar();
  $('#modalPanel').scrollTop = 0;
}

function backToLocation() {
  view.carKey = null;
  renderLocation();
}

function renderCar() {
  const loc = locByCode(view.code);
  const car = loc && allCars(loc).find((c) => c.key === view.carKey);
  if (!car) { backToLocation(); return; }
  const checked = isChecked(loc.code, car);
  const panel = $('#modalPanel');

  const toggle = el('button', { class: `collect-btn${checked ? ' on' : ''}`, onclick: () => {
    setChecked(loc.code, car, !isChecked(loc.code, car));
    renderCar();
  } }, el('span', { class: 'collect-box', text: checked ? '✓' : '' }), checked ? 'Collected' : 'Mark as collected');

  const others = data.locations.filter((l) => l.code !== loc.code && allCars(l).some((c) => c.key === car.key));

  panel.className = 'modal-panel car-view';
  panel.replaceChildren(
    el('div', { class: 'car-top' },
      el('button', { class: 'btn ghost back', onclick: backToLocation, text: `← ${loc.code} · ${loc.name}` }),
      el('button', { class: 'close-btn', title: 'Close (Esc)', onclick: closeModal, text: '×' })),
    el('div', { class: 'car-hero' },
      car.image ? el('button', { class: 'img-btn', onclick: () => lightbox(car.image.url) }, img(car.image.url, 1200, { class: 'hero-img' }))
        : el('div', { class: 'img-missing hero-img' })),
    el('div', { class: 'car-title' },
      el('div', {},
        el('div', { class: 'car-kicker', text: [car.year, car.category].filter(Boolean).join(' · ') }),
        el('h1', { text: car.name }),
        el('div', { class: 'car-tags' },
          el('span', { class: 'price-big', text: fmtCr(car.price) }),
          car.discount ? el('span', { class: 'chip', text: `${car.discount} discount` }) : null,
          el('span', { class: `chip ${car.modified ? 'mod' : ''}`, text: car.modified ? 'Modified' : 'Stock' }),
          car.wikiUrl ? el('button', { class: 'link', onclick: () => tracker.openExternal(car.wikiUrl), text: 'Car page ↗' }) : null)),
      el('div', { class: 'car-title-right' }, piBadge(car.pi, true), toggle)),
    el('div', { class: 'car-grid' },
      el('section', { class: 'stats' },
        el('h3', { text: 'Performance' }),
        STATS.map(([k, label]) => {
          const v = car.stats[k];
          return el('div', { class: 'stat' },
            el('span', { class: 'stat-label', text: label }),
            el('div', { class: 'stat-bar' }, el('div', { class: 'stat-fill', style: `width:${v == null ? 0 : Math.min(100, v * 10)}%` })),
            el('span', { class: 'stat-val', text: v == null ? '—' : v.toFixed(1) }));
        })),
      el('section', { class: 'flavor' },
        el('h3', { text: 'Flavor Text' }),
        el('blockquote', { text: car.flavor || '—' }),
        car.notes.length ? el('ul', { class: 'notes' }, car.notes.map((n) => el('li', { text: n }))) : null,
        others.length ? el('div', { class: 'also' }, el('span', { class: 'muted', text: 'Also sold at ' }),
          others.map((l) => el('button', { class: 'chip link-chip', onclick: () => { view.code = l.code; view.newKeys = new Set(); openCar(car.key); }, text: l.code }))) : null)),
    car.photos && car.photos.length ? el('section', { class: 'photos' },
      el('h3', { text: 'At the location' }),
      el('div', { class: 'photo-row' }, car.photos.map((ph) => el('figure', {},
        el('button', { class: 'img-btn', onclick: () => lightbox(ph.url) }, img(ph.url, 640)),
        el('figcaption', { text: ph.caption }))))) : null,
    car.modified ? partsSection(car, loc) : null);
}

function partsSection(car, loc) {
  const parts = car.parts;
  if (!parts) {
    return el('section', { class: 'parts' },
      el('h3', { text: 'Modified Car Parts List & Price Breakdown' }),
      el('p', { class: 'muted', text: 'The wiki has no parts list for this car yet.' }));
  }
  return el('section', { class: 'parts' },
    el('h3', { text: 'Modified Car Parts List & Price Breakdown' }),
    el('div', { class: 'parts-sub muted', text: parts.location !== loc.code
      ? `${parts.heading} — from the ${parts.location} page` : parts.heading }),
    dataTable(parts.table, 'parts-table'),
    parts.tuning ? el('h3', { class: 'tuning-head', text: 'Tuning' }) : null,
    parts.tuning ? dataTable(parts.tuning, 'tuning-table') : null,
    parts.notes.length ? el('ul', { class: 'notes' }, parts.notes.map((n) => el('li', { text: n }))) : null);
}

function dataTable(table, cls) {
  const cols = Math.max(table.headers.length, ...table.rows.map((r) => r.cells.reduce((n, c) => n + c.colspan, 0)));
  return el('table', { class: `data ${cls}` },
    table.headers.length ? el('thead', {}, el('tr', {}, table.headers.map((h) => el('th', { text: h })))) : null,
    el('tbody', {}, table.rows.map((r) => {
      const label = r.cells[0] ? r.cells[0].text : '';
      const strong = r.bold || /total|base price|final price/i.test(label);
      return el('tr', { class: `${strong ? 'strong' : ''}${r.section ? ' section' : ''}${/final price/i.test(label) ? ' final' : ''}` },
        r.cells.map((c, i) => el('td', {
          colspan: r.section ? cols : (c.colspan > 1 ? c.colspan : null),
          class: i === r.cells.length - 1 && !r.section && r.cells.length > 1 ? 'num' : null,
          text: c.text,
        })));
    })));
}

// ------------------------------------------------------------------ lightbox

function lightbox(url) {
  $('#lightboxImg').src = wimg(url, 1920);
  $('#lightbox').classList.remove('hidden');
}

// ------------------------------------------------------------------ sync

function setStatus(text, busy = false) {
  $('#statusText').textContent = text;
  $('#status').classList.toggle('busy', busy);
  $('#refreshBtn').classList.toggle('spin', busy);
}

function idleStatus(extra = '') {
  if (!data) return;
  const built = data.builtAt ? new Date(data.builtAt).toLocaleString() : 'unknown';
  setStatus(`${data.locations.length} locations · wiki data from ${built} · checked ${timeAgo(state.lastSync)}${extra}`);
}

async function runSync(force = false) {
  setStatus(force ? 'Re-downloading everything…' : 'Checking the wiki for changes…', true);
  try {
    const res = await tracker.sync(force);
    data = res.data;
    state.lastSync = Date.now();
    saveState();
    ensureKnown();
    refreshAll();
    const bits = [];
    if (res.updated.length) bits.push(`${res.updated.length} page${res.updated.length === 1 ? '' : 's'} updated`);
    if (res.errors.length) bits.push(`${res.errors.length} error(s): ${res.errors[0]}`);
    idleStatus(bits.length ? ` · ${bits.join(' · ')}` : ' · up to date');
  } catch (err) {
    console.error(err);
    setStatus(data
      ? `Couldn't reach the wiki (${err.message}). Showing saved data.`
      : `Couldn't reach the wiki (${err.message}). Check your connection and press refresh.`);
  }
}

function refreshAll() {
  renderGrid();
  if (view.code) {
    if (view.carKey) renderCar();
    else { rememberScroll(); renderLocation(); }
  }
}

// ------------------------------------------------------------------ wiring

function wire() {
  $('#search').addEventListener('input', () => renderGrid());
  $('#filter').addEventListener('change', (e) => { state.ui.filter = e.target.value; saveState(); renderGrid(); });
  $('#refreshBtn').addEventListener('click', () => runSync(false));
  $('#forceRefreshBtn').addEventListener('click', () => { $('#settings').classList.add('hidden'); runSync(true); });
  $('#dataDirBtn').addEventListener('click', () => tracker.openDataDir());

  $('#settingsBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#settings').classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#settings')) $('#settings').classList.add('hidden');
  });

  $('#optLinked').addEventListener('change', (e) => {
    const linked = e.target.checked;
    // Carry ticks over so switching modes never loses anything.
    for (const loc of data ? data.locations : []) {
      for (const car of allCars(loc)) {
        const locKey = `${loc.code}|${car.key}`;
        if (linked && state.checkedLoc[locKey]) state.checked[car.key] = state.checkedLoc[locKey];
        if (!linked && state.checked[car.key]) state.checkedLoc[locKey] = state.checked[car.key];
      }
    }
    state.settings.linkIdentical = linked;
    saveState();
    refreshAll();
  });
  $('#optEvents').addEventListener('change', (e) => {
    state.settings.countEvents = e.target.checked;
    saveState();
    refreshAll();
  });

  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#lightbox').addEventListener('click', () => $('#lightbox').classList.add('hidden'));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#lightbox').classList.contains('hidden')) $('#lightbox').classList.add('hidden');
    else if (view.carKey) backToLocation();
    else if (view.code) closeModal();
    else $('#settings').classList.add('hidden');
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 3 && view.carKey) backToLocation(); // mouse "back" button
  });
}

async function init() {
  wire();
  tracker.onSyncProgress((p) => setStatus(p.phase, true));
  const [cached, saved] = await Promise.all([tracker.getData(), tracker.getState()]);
  const d = defaults();
  state = { ...d, ...saved, settings: { ...d.settings, ...(saved.settings || {}) }, ui: { ...d.ui, ...(saved.ui || {}) } };
  $('#optLinked').checked = state.settings.linkIdentical;
  $('#optEvents').checked = state.settings.countEvents;
  $('#filter').value = state.ui.filter;

  const params = new URLSearchParams(location.search);
  data = cached;
  if (data) {
    ensureKnown();
    renderGrid();
    idleStatus();
  } else {
    $('#grid').replaceChildren(el('div', { class: 'empty', text: 'Downloading the location list from the Forza wiki…' }));
  }
  // With cached data the check runs in the background; on first launch we have to wait for it.
  const syncing = !data || !params.has('nosync') ? runSync(false) : null;
  if (!data) await syncing;

  if (params.get('open')) {
    openLocation(params.get('open'));
    const idx = Number(params.get('car'));
    const loc = locByCode(params.get('open'));
    if (loc && params.has('car') && allCars(loc)[idx]) openCar(allCars(loc)[idx].key);
    if (params.get('scroll')) $('#modalPanel').scrollTop = Number(params.get('scroll'));
  }
  tracker.rendered();
}

init();
