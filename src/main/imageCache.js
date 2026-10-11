'use strict';
// On-disk cache for wiki images. Fandom image URLs carry a `cb` (cache-buster) query
// parameter that changes whenever a new version of the file is uploaded, so an image is
// only downloaded again when its `cb` differs from the one we stored.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson, USER_AGENT } = require('./wiki');

const ALLOWED_HOST = 'static.wikia.nocookie.net';
const EXT_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

class ImageCache {
  constructor(dir) {
    this.dir = dir;
    this.manifestPath = path.join(dir, 'manifest.json');
    fs.mkdirSync(dir, { recursive: true });
    this.manifest = readJson(this.manifestPath, {});
    this.inflight = new Map();
    this.saveTimer = null;
  }

  /** Resolve a wiki image URL to { file, type }, downloading it if needed. */
  get(url) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== ALLOWED_HOST) throw new Error(`Blocked image host ${u.hostname}`);
    const key = u.pathname; // includes the scale-to-width part, so each size is cached separately
    const cb = u.searchParams.get('cb') || '';
    const entry = this.manifest[key];
    if (entry && entry.cb === cb && fs.existsSync(path.join(this.dir, entry.file))) {
      return Promise.resolve(this.result(entry));
    }
    if (!this.inflight.has(url)) {
      const p = this.download(url, key, cb)
        .catch((err) => {
          // Offline or the wiki hiccuped: fall back to whatever version we already have.
          if (entry && fs.existsSync(path.join(this.dir, entry.file))) return this.result(entry);
          throw err;
        })
        .finally(() => this.inflight.delete(url));
      this.inflight.set(url, p);
    }
    return this.inflight.get(url);
  }

  async download(url, key, cb) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(90000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const type = (res.headers.get('content-type') || '').split(';')[0] || guessType(key);
    const ext = Object.keys(EXT_TYPES).find((e) => EXT_TYPES[e] === type) || path.extname(key.split('/revision/')[0]) || '.img';
    const file = crypto.createHash('sha1').update(key).digest('hex') + ext;
    const old = this.manifest[key];
    fs.writeFileSync(path.join(this.dir, file), buf);
    if (old && old.file !== file) fs.rmSync(path.join(this.dir, old.file), { force: true });
    const entry = { cb, file, type, fetchedAt: Date.now() };
    this.manifest[key] = entry;
    this.scheduleSave();
    return this.result(entry);
  }

  result(entry) {
    return { file: path.join(this.dir, entry.file), type: entry.type || guessType(entry.file) };
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 1000);
  }

  flush() {
    clearTimeout(this.saveTimer);
    writeJson(this.manifestPath, this.manifest);
  }
}

function guessType(name) {
  const m = String(name).toLowerCase().match(/\.(png|jpe?g|gif|webp|svg)/);
  return m ? EXT_TYPES[`.${m[1]}`] : 'application/octet-stream';
}

module.exports = { ImageCache };
