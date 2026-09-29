import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('erp', {
  login: (email: string, password: string) => ipcRenderer.invoke('erp:login', email, password),
  tenants: () => ipcRenderer.invoke('erp:tenants'),
  selectTenant: (tenantId: string) => ipcRenderer.invoke('erp:select-tenant', tenantId),
  acceptInvitation: (input: unknown) => ipcRenderer.invoke('erp:accept-invitation', input),
  request: (method: string, path: string, body?: unknown) => ipcRenderer.invoke('erp:request', method, path, body),
  logout: () => ipcRenderer.invoke('erp:logout'),
  session: () => ipcRenderer.invoke('erp:session'),
  onConnection: (listener: (state: { online: boolean }) => void) => {
    const wrapped = (_event: unknown, state: { online: boolean }) => listener(state);
    ipcRenderer.on('erp:connection', wrapped);
    return () => {
      ipcRenderer.removeListener('erp:connection', wrapped);
    };
  },
});
