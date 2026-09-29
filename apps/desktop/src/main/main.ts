import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from 'electron';
import { ApiSession } from './api-session.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const rendererUrl = process.env.NEC_RENDERER_URL ?? null;
const apiBaseUrl = process.env.NEC_API_URL ?? 'http://127.0.0.1:4000';

if (app.isPackaged && !apiBaseUrl.startsWith('https://')) {
  throw new Error('Packaged builds require an HTTPS API URL');
}

app.enableSandbox();
const api = new ApiSession(apiBaseUrl);
let mainWindow: BrowserWindow | null = null;

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

const statePath = () => join(app.getPath('userData'), 'window-state.json');

function loadWindowState(): WindowState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as WindowState;
    if (parsed.width >= 800 && parsed.height >= 600) {
      return parsed;
    }
  } catch {
    return { width: 1280, height: 800 };
  }
  return { width: 1280, height: 800 };
}

function saveWindowState(window: BrowserWindow): void {
  const bounds = window.getNormalBounds();
  const state: WindowState = { ...bounds, maximized: window.isMaximized() };
  try {
    writeFileSync(statePath(), JSON.stringify(state));
  } catch {
    return;
  }
}

function appOrigin(): string {
  return rendererUrl ? new URL(rendererUrl).origin : 'file://';
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  return rendererUrl ? url.startsWith(appOrigin()) : url.startsWith('file://');
}

function handle(channel: string, listener: (...args: unknown[]) => Promise<unknown>): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) {
      throw new Error('Untrusted IPC sender');
    }
    return listener(...args);
  });
}

function createWindow(): void {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'NEC ERP',
    webPreferences: {
      preload: join(here, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: true,
    },
  });
  if (state.maximized) {
    mainWindow.maximize();
  }
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', () => mainWindow && saveWindowState(mainWindow));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(appOrigin())) {
      event.preventDefault();
    }
  });
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(join(here, '../renderer/index.html'));
  }
}

function broadcastConnection(online: boolean): void {
  mainWindow?.webContents.send('erp:connection', { online });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  handle('erp:login', (email, password) => api.login(String(email), String(password)));
  handle('erp:tenants', () => api.tenants());
  handle('erp:select-tenant', (tenantId) => api.selectTenant(String(tenantId)));
  handle('erp:accept-invitation', (input) => api.acceptInvitation(input as Parameters<ApiSession['acceptInvitation']>[0]));
  handle('erp:request', (method, path, body) => api.request(String(method), String(path), body));
  handle('erp:logout', () => api.logout());
  handle('erp:session', async () => ({ user: api.user, tenant: api.tenant }));

  createWindow();
  let lastOnline: boolean | null = null;
  setInterval(async () => {
    const online = await api.health();
    if (online !== lastOnline) {
      lastOnline = online;
      broadcastConnection(online);
    }
  }, 10000);
  void api.health().then((online) => {
    lastOnline = online;
    broadcastConnection(online);
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
