import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('erp', {
  login: (email: string, password: string) => ipcRenderer.invoke('erp:login', email, password),
  tenants: () => ipcRenderer.invoke('erp:tenants'),
  selectTenant: (tenantId: string) => ipcRenderer.invoke('erp:select-tenant', tenantId),
  acceptInvitation: (input: unknown) => ipcRenderer.invoke('erp:accept-invitation', input),
  request: (method: string, path: string, body?: unknown) => ipcRenderer.invoke('erp:request', method, path, body),
  logout: () => ipcRenderer.invoke('erp:logout'),
  verifyMfa: (code: string) => ipcRenderer.invoke('erp:verify-mfa', code),
  mfa: (action: string, body?: unknown) => ipcRenderer.invoke('erp:mfa', action, body),
  requestPasswordReset: (email: string) => ipcRenderer.invoke('erp:request-password-reset', email),
  confirmPasswordReset: (token: string, password: string) => ipcRenderer.invoke('erp:confirm-password-reset', token, password),
  changePassword: (currentPassword: string, newPassword: string) => ipcRenderer.invoke('erp:change-password', currentPassword, newPassword),
  session: () => ipcRenderer.invoke('erp:session'),
  saveTextFile: (name: string, content: string) => ipcRenderer.invoke('erp:save-text-file', name, content),
  exportCompany: () => ipcRenderer.invoke('erp:export-company'),
  saveInvoicePdf: (invoiceId: string) => ipcRenderer.invoke('erp:save-invoice-pdf', invoiceId),
  printInvoice: (invoiceId: string) => ipcRenderer.invoke('erp:print-invoice', invoiceId),
  onConnection: (listener: (state: { online: boolean }) => void) => {
    const wrapped = (_event: unknown, state: { online: boolean }) => listener(state);
    ipcRenderer.on('erp:connection', wrapped);
    return () => {
      ipcRenderer.removeListener('erp:connection', wrapped);
    };
  },
});
