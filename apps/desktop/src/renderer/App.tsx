import { useEffect, useState } from 'react';
import type { SessionUser, TenantSummary } from '@nec/contracts';
import { Banner } from '@nec/ui';
import { AcceptInvitationScreen } from './screens/AcceptInvitationScreen';
import { LoginScreen } from './screens/LoginScreen';
import { Shell } from './screens/Shell';
import { TenantChooser } from './screens/TenantChooser';

type View =
  | { kind: 'login'; notice?: string }
  | { kind: 'accept' }
  | { kind: 'choose'; user: SessionUser; tenants: TenantSummary[] }
  | { kind: 'shell'; user: SessionUser; tenant: TenantSummary; tenants: TenantSummary[] };

export function App() {
  const [view, setView] = useState<View>({ kind: 'login' });
  const [online, setOnline] = useState(true);

  useEffect(() => window.erp.onConnection((state) => setOnline(state.online)), []);

  const logout = async () => {
    await window.erp.logout();
    setView({ kind: 'login', notice: 'You have signed out.' });
  };

  return (
    <>
      {!online ? (
        <div className="connection-bar" role="status">
          <Banner tone="warning">
            Connection to the server lost. Nothing is posted while offline; unsent input on this screen is kept.
          </Banner>
        </div>
      ) : null}
      {view.kind === 'login' ? (
        <LoginScreen
          notice={view.notice}
          onSignedIn={(user, tenants) => setView({ kind: 'choose', user, tenants })}
          onAcceptInvitation={() => setView({ kind: 'accept' })}
        />
      ) : null}
      {view.kind === 'accept' ? (
        <AcceptInvitationScreen
          onDone={(message) => setView({ kind: 'login', notice: message })}
          onCancel={() => setView({ kind: 'login' })}
        />
      ) : null}
      {view.kind === 'choose' ? (
        <TenantChooser
          user={view.user}
          tenants={view.tenants}
          onSelected={(tenant) => setView({ kind: 'shell', user: view.user, tenant, tenants: view.tenants })}
          onLogout={logout}
        />
      ) : null}
      {view.kind === 'shell' ? (
        <Shell
          key={view.tenant.tenantId}
          user={view.user}
          tenant={view.tenant}
          canSwitch={view.tenants.length > 1}
          online={online}
          onSwitchTenant={() => setView({ kind: 'choose', user: view.user, tenants: view.tenants })}
          onLogout={logout}
          onSessionExpired={() => setView({ kind: 'login', notice: 'Your session expired. Sign in again.' })}
        />
      ) : null}
    </>
  );
}
