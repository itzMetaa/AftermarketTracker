'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, shell } = require('electron');
const { WikiSync, readJson, writeFileAtomic } = require('./wiki');
const { ImageCache } = require('./imageCache');

// Renderer pages load wiki images through wimg://img/?u=<encoded static.wikia URL>.
protocol.registerSchemesAsPrivileged([
  { scheme: 'wimg', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

app.setAppUserModelId('local.aftermarket-tracker');
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let wiki = null;
let images = null;
let statePath = null;

function cliArg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#120a18',
    title: 'Aftermarket Tracker',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.once('ready-to-show', () => win.show());

  // Dev hooks: --open=SOT1 [--car=<index>] --screenshot=out.png
  const query = {};
  for (const k of ['open', 'car', 'scroll', 'nosync']) if (cliArg(k) != null) query[k] = cliArg(k);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query });

  // Links clicked inside the app open in the user's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function registerIpc() {
  ipcMain.handle('data:get', () => wiki.loadData());

  ipcMain.handle('data:sync', async (event, { force } = {}) => {
    const sender = event.sender;
    const result = await wiki.sync({
      force: !!force,
      onProgress: (p) => { if (!sender.isDestroyed()) sender.send('sync:progress', p); },
    });
    return result;
  });

  ipcMain.handle('state:get', () => readJson(statePath, {}));
  ipcMain.handle('state:set', (_e, state) => {
    writeFileAtomic(statePath, JSON.stringify(state, null, 1));
    return true;
  });

  ipcMain.handle('shell:open', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\/forza\.fandom\.com\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('shell:openDataDir', () => shell.openPath(app.getPath('userData')));

  ipcMain.on('ui:rendered', async () => {
    const shot = cliArg('screenshot');
    if (!shot || !win) return;
    await new Promise((r) => setTimeout(r, Number(cliArg('delay') || 2500)));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(shot, img.toPNG());
    app.quit();
  });
}

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  const cacheDir = path.join(userData, 'cache');
  wiki = new WikiSync(cacheDir);
  images = new ImageCache(path.join(cacheDir, 'images'));
  statePath = path.join(userData, 'collection.json');

  protocol.handle('wimg', async (req) => {
    try {
      const target = new URL(req.url).searchParams.get('u');
      const { file, type } = await images.get(target);
      return new Response(await fs.promises.readFile(file), {
        headers: { 'content-type': type, 'cache-control': 'max-age=31536000' },
      });
    } catch (err) {
      return new Response(String(err.message || err), { status: 404 });
    }
  });

  registerIpc();
  createWindow();
});

app.on('before-quit', () => images && images.flush());
app.on('window-all-closed', () => app.quit());
