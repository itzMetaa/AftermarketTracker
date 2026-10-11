#!/usr/bin/env node
'use strict';
// Health check for the wiki parser. Downloads the live wiki (or reuses a cache dir) and
// reports anything that looks like a layout change. Run: npm run check-wiki [-- --cache <dir>] [--force] [--dump <CODE>]
// Exit code 1 means something needs attention (see AGENTS.md).

const os = require('os');
const path = require('path');
const { WikiSync } = require('../src/main/wiki');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const cacheDir = opt('--cache') || path.join(os.tmpdir(), 'aftermarket-tracker-check');
const dump = opt('--dump');

(async () => {
  const wiki = new WikiSync(cacheDir);
  const { data, updated, errors } = await wiki.sync({
    force: args.includes('--force'),
    onProgress: (p) => process.stderr.write(`\r${p.phase.padEnd(60)}`),
  });
  process.stderr.write('\n');
  console.log(`Cache: ${cacheDir}`);
  console.log(`Downloaded ${updated.length} page(s). Locations: ${data.locations.length}\n`);

  const problems = [...errors];
  const regions = new Map();
  let carCount = 0;
  for (const loc of data.locations) {
    regions.set(loc.region, (regions.get(loc.region) || 0) + 1);
    const cars = loc.groups.flatMap((g) => g.cars);
    carCount += cars.length;
    const groups = loc.groups.map((g) => `${g.event ? '[event] ' : ''}${[...g.context, g.title].join(' > ')}(${g.cars.length})`);
    console.log(`${loc.code.padEnd(5)} ${loc.region.padEnd(12)} ${loc.name.padEnd(20)} ${groups.join(', ')}`
      + (loc.trivia.length ? `  trivia:${loc.trivia.length}` : ''));
    for (const w of loc.warnings) problems.push(`${loc.code}: ${w}`);
    if (loc.region === 'Other') problems.push(`${loc.code}: region unknown (not in index page tables)`);
    for (const car of cars) {
      const label = `${loc.code}: ${car.year || '????'} ${car.name}`;
      if (!car.image) problems.push(`${label}: no image`);
      if (!car.pi) problems.push(`${label}: no PI`);
      if (car.price == null) problems.push(`${label}: no price`);
      const stats = Object.values(car.stats).filter((v) => v != null).length;
      if (stats < 6) problems.push(`${label}: only ${stats}/6 stats`);
      if (car.modified && !car.parts) problems.push(`${label}: modified but no parts list matched (info only)`);
      if (car.parts && car.parts.finalPrice != null && car.price != null
        && Math.abs(car.parts.finalPrice - car.price) > 2) {
        problems.push(`${label}: parts list "${car.parts.heading}" (${car.parts.location}) final price `
          + `${car.parts.finalPrice} != ${car.price} (info only)`);
      }
    }
  }
  console.log(`\nRegions: ${[...regions].map(([r, n]) => `${r} (${n})`).join(', ')}`);
  console.log(`Car rows: ${carCount}`);

  if (dump) {
    const loc = data.locations.find((l) => l.code === dump);
    console.log(JSON.stringify(loc, null, 2));
  }

  const serious = problems.filter((p) => !p.includes('(info only)'));
  console.log(`\n${problems.length ? problems.map((p) => `- ${p}`).join('\n') : 'No problems found.'}`);
  if (!data.locations.length) serious.push('No locations parsed at all');
  process.exit(serious.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
