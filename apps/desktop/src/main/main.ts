import { readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, session, type IpcMainInvokeEvent } from 'electron';
import { ApiSession } from './api-session.js';
import type { ArInvoiceDocument } from '@nec/contracts';
import { validateCsvExport, withCsvExtension } from './export-file.js';
import { invoicePdfName, renderInvoiceHtml, validateInvoiceId } from './invoice-document.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const rendererUrl = process.env.NEC_RENDERER_URL ?? null;
const apiBaseUrl = process.env.NEC_API_URL ?? bundledApiUrl() ?? 'http://127.0.0.1:4000';

function bundledApiUrl(): string | null {
  try {
    const config = JSON.parse(readFileSync(join(app.getAppPath(), 'app-config.json'), 'utf8')) as { apiUrl?: unknown };
    return typeof config.apiUrl === 'string' && config.apiUrl.length > 0 ? config.apiUrl : null;
  } catch {
    return null;
  }
}

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

async function loadInvoiceWindow(invoiceId: unknown): Promise<{ window: BrowserWindow; document: ArInvoiceDocument }> {
  const id = validateInvoiceId(invoiceId);
  const result = await api.request('GET', `/v1/sal/invoices/${id}/document`);
  if (!result.ok) {
    const message = (result.body as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(message ?? 'The invoice could not be loaded');
  }
  const document = result.body as ArInvoiceDocument;
  const window = new BrowserWindow({
    show: false,
    parent: mainWindow ?? undefined,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderInvoiceHtml(document))}`);
  return { window, document };
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
  handle('erp:request-password-reset', (email) => api.requestPasswordReset(String(email)));
  handle('erp:confirm-password-reset', (token, password) => api.confirmPasswordReset(String(token), String(password)));
  handle('erp:verify-mfa', (code) => api.verifyMfa(String(code)));
  handle('erp:mfa', (action, body) => {
    if (action !== 'status' && action !== 'setup' && action !== 'enable' && action !== 'disable') throw new Error('Invalid two-factor action');
    return api.mfa(action, body);
  });
  handle('erp:change-password', (currentPassword, newPassword) => api.changePassword(String(currentPassword), String(newPassword)));
  handle('erp:session', async () => ({ user: api.user, tenant: api.tenant }));
  handle('erp:save-text-file', async (name, content) => {
    const file = validateCsvExport(name, content);
    if (!mainWindow) return { saved: false };
    const choice = await dialog.showSaveDialog(mainWindow, { defaultPath: file.name, filters: [{ name: 'CSV (comma separated)', extensions: ['csv'] }] });
    if (choice.canceled || !choice.filePath) return { saved: false };
    await writeFile(withCsvExtension(choice.filePath), file.content, 'utf8');
    return { saved: true };
  });
  handle('erp:export-company', async () => {
    if (!mainWindow) return { saved: false };
    const result = await api.request('GET', '/v1/tenant/export');
    if (!result.ok) {
      const message = (result.body as { error?: { message?: string } } | null)?.error?.message;
      throw new Error(message ?? 'The company data could not be exported');
    }
    const body = result.body as { tenant?: { code?: string } };
    const code = (body.tenant?.code ?? 'company').replace(/[^A-Za-z0-9_-]/g, '-');
    const choice = await dialog.showSaveDialog(mainWindow, { defaultPath: `${code} export ${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (choice.canceled || !choice.filePath) return { saved: false };
    await writeFile(choice.filePath.toLowerCase().endsWith('.json') ? choice.filePath : `${choice.filePath}.json`, JSON.stringify(result.body, null, 2), 'utf8');
    return { saved: true };
  });
  handle('erp:save-invoice-pdf', async (invoiceId) => {
    if (!mainWindow) return { saved: false };
    const { window, document } = await loadInvoiceWindow(invoiceId);
    try {
      const pdf = await window.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true });
      const choice = await dialog.showSaveDialog(mainWindow, { defaultPath: invoicePdfName(document), filters: [{ name: 'PDF document', extensions: ['pdf'] }] });
      if (choice.canceled || !choice.filePath) return { saved: false };
      await writeFile(choice.filePath.toLowerCase().endsWith('.pdf') ? choice.filePath : `${choice.filePath}.pdf`, pdf);
      return { saved: true };
    } finally {
      window.destroy();
    }
  });
  handle('erp:print-invoice', async (invoiceId) => {
    const { window } = await loadInvoiceWindow(invoiceId);
    return new Promise<{ printed: boolean }>((resolve) => {
      window.webContents.print({ printBackground: true }, (printed) => {
        window.destroy();
        resolve({ printed });
      });
    });
  });

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
