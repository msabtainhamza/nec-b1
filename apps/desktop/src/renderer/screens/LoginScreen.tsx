import { useState, type FormEvent } from 'react';
import type { SessionUser, TenantSummary } from '@nec/contracts';
import { Banner, Button, FormWindow, TextField } from '@nec/ui';
import { errorMessage } from '../api';

export function LoginScreen({
  notice,
  onSignedIn,
  onAcceptInvitation,
}: {
  notice?: string;
  onSignedIn: (user: SessionUser, tenants: TenantSummary[]) => void;
  onAcceptInvitation: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || !email || !password) {
      return;
    }
    setBusy(true);
    setError(null);
    const result = await window.erp.login(email, password);
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setPassword('');
    onSignedIn(result.body.user, result.body.tenants);
  };

  return (
    <main className="dialog-layout">
      <form onSubmit={submit} noValidate>
        <FormWindow
          title="Log On"
          footerLeft={
            <>
              <Button type="submit" variant="primary" busy={busy} disabled={!email || !password}>
                OK
              </Button>
            </>
          }
          footerRight={
            <Button type="button" onClick={onAcceptInvitation}>
              Accept Invitation
            </Button>
          }
        >
          <div className="dialog-product">
            <strong>NEC ERP</strong>
            <span className="ui-muted">Trading and Distribution</span>
          </div>
          {notice ? <Banner tone="info">{notice}</Banner> : null}
          {error ? <Banner>{error}</Banner> : null}
          <TextField label="User ID (email)" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          <TextField label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </FormWindow>
      </form>
    </main>
  );
}
