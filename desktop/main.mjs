// Agent Token Meter desktop app: runs the multi-provider hub + local dashboard
// in the main process and shows it in a main window, an always-on-top mini
// window and a tray menu. Everything stays on 127.0.0.1.
import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, safeStorage, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const METER = app.isPackaged ? path.join(process.resourcesPath, 'meter') : path.join(HERE, '..', 'plugins', 'codex-token-meter');
const load = (rel) => import(pathToFileURL(path.join(METER, rel)).href);
const SMOKE = process.argv.includes('--smoke');

const { Hub, PROVIDER_IDS, PROVIDER_META } = await load('src/hub.js');
const { startWeb } = await load('src/web.js');
const { useSqlJs } = await load('src/sqlite.js');
try {
  useSqlJs(createRequire(import.meta.url)('sql.js'));
} catch {}

const DEFAULTS = { providers: [...PROVIDER_IDS], sinceHours: 24, port: 4399, miniOnTop: true, devin: { orgId: '', baseUrl: '' }, devinKey: null };
const configFile = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configFile(), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// The Devin API key is encrypted with the OS keychain (safeStorage) when available.
function encodeKey(key) {
  if (!key) return null;
  if (safeStorage.isEncryptionAvailable()) return { enc: safeStorage.encryptString(key).toString('base64') };
  return { plain: key };
}

function decodeKey(stored) {
  if (!stored) return process.env.DEVIN_API_KEY || null;
  try {
    if (stored.enc) return safeStorage.decryptString(Buffer.from(stored.enc, 'base64'));
  } catch {
    return null;
  }
  return stored.plain || null;
}

let config;
let hub;
let server;
let baseUrl;
let mainWin = null;
let miniWin = null;
let settingsWin = null;
let tray = null;
let quitting = false;

function createHub() {
  const h = new Hub({
    providers: config.providers.filter((id) => PROVIDER_IDS.includes(id)),
    sinceHours: config.sinceHours,
    devin: { apiKey: decodeKey(config.devinKey), orgId: config.devin?.orgId || undefined, baseUrl: config.devin?.baseUrl || undefined },
  });
  h.start();
  return h;
}

/** Re-points the running web server at a new hub (the server reads the store passed at start). */
async function restartServer() {
  if (server) {
    const old = server;
    await new Promise((r) => {
      old.close(() => r());
      old.closeAllConnections?.();
    });
  }
  for (const port of [config.port, 0]) {
    try {
      server = await startWeb(hub, { port, host: '127.0.0.1' });
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

const webPrefs = () => ({ preload: path.join(HERE, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true });

function routeLinks(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(baseUrl) && new URL(url).pathname.startsWith('/mini')) {
      openMini();
      return { action: 'deny' };
    }
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function openMain() {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.show();
    mainWin.focus();
    return mainWin;
  }
  mainWin = new BrowserWindow({ width: 1280, height: 820, minWidth: 720, minHeight: 480, title: 'Agent Token Meter', backgroundColor: '#0d1117', icon: path.join(HERE, 'build', 'icon.png'), show: !SMOKE, webPreferences: webPrefs() });
  mainWin.setMenuBarVisibility(false);
  routeLinks(mainWin);
  mainWin.loadURL(`${baseUrl}/`);
  mainWin.on('close', (e) => {
    if (!quitting && tray) {
      e.preventDefault();
      mainWin.hide();
    }
  });
  return mainWin;
}

function openMini() {
  if (miniWin && !miniWin.isDestroyed()) {
    miniWin.show();
    miniWin.focus();
    return miniWin;
  }
  miniWin = new BrowserWindow({ width: 360, height: 520, minWidth: 280, minHeight: 240, title: 'Agent Token Meter · Mini', backgroundColor: '#0d1117', alwaysOnTop: config.miniOnTop, skipTaskbar: false, maximizable: false, fullscreenable: false, show: !SMOKE, webPreferences: webPrefs() });
  miniWin.setMenuBarVisibility(false);
  if (config.miniOnTop) miniWin.setAlwaysOnTop(true, 'floating');
  routeLinks(miniWin);
  miniWin.loadURL(`${baseUrl}/mini`);
  miniWin.on('closed', () => (miniWin = null));
  return miniWin;
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }
  settingsWin = new BrowserWindow({ width: 560, height: 680, title: 'Agent Token Meter · 设置', backgroundColor: '#0d1117', show: !SMOKE, webPreferences: webPrefs() });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(HERE, 'settings.html'));
  settingsWin.on('closed', () => (settingsWin = null));
  return settingsWin;
}

function buildTray() {
  const img = nativeImage.createFromPath(path.join(HERE, 'build', 'tray.png'));
  if (process.platform === 'darwin') img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Agent Token Meter');
  const refresh = () => {
    const snap = hub.snapshot({ limit: 1 });
    const t = snap.totals;
    const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0));
    tray.setToolTip(`Agent Token Meter — ${fmt(t.all.total)} tokens${t.cost != null ? ` · ~$${t.cost.toFixed(2)}` : ''}${t.acus != null ? ` · ${Math.round(t.acus * 100) / 100} ACU` : ''}`);
    const providers = snap.providers.map((p) => ({ label: `${p.name}: ${p.state}${p.sessions ? ` (${p.sessions})` : ''}`, enabled: false }));
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开仪表盘', click: openMain },
        { label: '悬浮小窗', click: openMini },
        { label: '小窗置顶', type: 'checkbox', checked: config.miniOnTop, click: (i) => setMiniOnTop(i.checked) },
        { type: 'separator' },
        ...providers,
        { type: 'separator' },
        { label: '设置…', click: openSettings },
        { label: '开机自动启动', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
      ]),
    );
  };
  refresh();
  let pending = null;
  hub.on('change', () => {
    if (!pending) pending = setTimeout(() => ((pending = null), refresh()), 1500);
  });
  tray.on('click', () => (process.platform === 'darwin' ? null : openMini()));
}

function setMiniOnTop(on) {
  config.miniOnTop = on;
  writeConfig(config);
  if (miniWin && !miniWin.isDestroyed()) miniWin.setAlwaysOnTop(on, 'floating');
  return on;
}

ipcMain.handle('atm:always-on-top', (e, on) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win === miniWin) return setMiniOnTop(on);
  win?.setAlwaysOnTop(on, 'floating');
  return on;
});
ipcMain.handle('atm:is-always-on-top', (e) => !!BrowserWindow.fromWebContents(e.sender)?.isAlwaysOnTop());
ipcMain.handle('atm:open-mini', () => void openMini());
ipcMain.handle('atm:open-settings', () => void openSettings());
ipcMain.handle('atm:provider-status', () => hub.snapshot({ limit: 0 }).providers);
ipcMain.handle('atm:get-settings', () => ({
  providers: config.providers,
  all: PROVIDER_IDS.map((id) => ({ id, ...PROVIDER_META[id] })),
  sinceHours: config.sinceHours,
  devinOrgId: config.devin?.orgId || '',
  devinBaseUrl: config.devin?.baseUrl || '',
  devinKeySet: !!decodeKey(config.devinKey),
  devinKeyFromEnv: !config.devinKey && !!process.env.DEVIN_API_KEY,
  keyEncrypted: safeStorage.isEncryptionAvailable(),
  url: baseUrl,
  configFile: configFile(),
}));
ipcMain.handle('atm:save-settings', async (_e, s) => {
  const next = { ...config, devin: { ...config.devin } };
  if (Array.isArray(s.providers)) next.providers = s.providers.filter((id) => PROVIDER_IDS.includes(id));
  if (Number(s.sinceHours) > 0) next.sinceHours = Number(s.sinceHours);
  if (typeof s.devinOrgId === 'string') next.devin.orgId = s.devinOrgId.trim();
  if (typeof s.devinBaseUrl === 'string') next.devin.baseUrl = s.devinBaseUrl.trim();
  if (s.clearDevinKey) next.devinKey = null;
  else if (typeof s.devinKey === 'string' && s.devinKey.trim()) next.devinKey = encodeKey(s.devinKey.trim());
  config = next;
  writeConfig(config);
  const old = hub;
  hub = createHub();
  old.stop();
  await restartServer();
  for (const w of [mainWin, miniWin]) if (w && !w.isDestroyed()) w.loadURL(`${baseUrl}${w === miniWin ? '/mini' : '/'}`);
  if (tray) {
    tray.destroy();
    buildTray();
  }
  if (hub.stores['devin-cloud']) await hub.stores['devin-cloud'].refresh();
  await hub.detect();
  return hub.snapshot({ limit: 0 }).providers;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openMain());
  app.on('before-quit', () => (quitting = true));
  app.on('window-all-closed', () => {
    if (!tray) app.quit();
  });
  app.on('activate', () => openMain());
  app.whenReady().then(async () => {
    config = readConfig();
    hub = createHub();
    await restartServer();
    if (SMOKE) return smoke();
    buildTray();
    openMain();
    if (process.argv.includes('--mini')) openMini();
  });
}

// --smoke: render the dashboard and mini window offscreen, save screenshots and print provider status.
async function smoke() {
  const out = process.env.ATM_SMOKE_DIR || app.getPath('temp');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await hub.detect();
  await wait(Number(process.env.ATM_SMOKE_WAIT || 4000));
  const shots = [];
  for (const [name, win] of [['dashboard', openMain()], ['mini', openMini()], ['settings', openSettings()]]) {
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
    await wait(1500);
    const file = path.join(out, `atm-${name}.png`);
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
    shots.push(file);
  }
  await hub.detect();
  console.log(JSON.stringify({ url: baseUrl, providers: hub.snapshot({ limit: 0 }).providers.map((p) => [p.id, p.state, p.sessions]), screenshots: shots }));
  quitting = true;
  app.exit(0);
}
