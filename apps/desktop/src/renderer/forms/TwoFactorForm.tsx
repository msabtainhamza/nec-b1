import { useCallback, useEffect, useState } from 'react';
import type { MfaEnableResponse, MfaSetupResponse, MfaStatus } from '@nec/contracts';
import { Banner, Button, FormWindow, TextField } from '@nec/ui';
import { errorMessage } from '../api';

export function TwoFactorForm({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [setup, setSetup] = useState<MfaSetupResponse | null>(null);
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await window.erp.mfa<MfaStatus>('status');
    if (result.ok) setStatus(result.body);
    else setError(errorMessage(result));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    await action();
    setBusy(false);
  };

  const start = () =>
    run(async () => {
      const result = await window.erp.mfa<MfaSetupResponse>('setup');
      if (result.ok) {
        setSetup(result.body);
        setCode('');
      } else setError(errorMessage(result));
    });

  const enable = () =>
    run(async () => {
      const result = await window.erp.mfa<MfaEnableResponse>('enable', { code: code.trim() });
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      setRecovery(result.body.recoveryCodes);
      setSetup(null);
      setCode('');
      await load();
    });

  const disable = () =>
    run(async () => {
      const result = await window.erp.mfa('disable', { password, code: code.trim() });
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      setPassword('');
      setCode('');
      setRecovery(null);
      setNotice('Two-factor authentication is now off for your account.');
      await load();
    });

  return (
    <FormWindow
      title="Two-Factor Authentication"
      width={560}
      onClose={onClose}
      footerLeft={
        <Button type="button" variant="primary" onClick={onClose}>
          OK
        </Button>
      }
    >
      {error ? <Banner>{error}</Banner> : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}
      {!status ? <p className="ui-muted">Loading…</p> : null}
      {recovery ? (
        <>
          <Banner tone="warning">Store these recovery codes somewhere safe. Each one signs you in once if you lose your device; they are shown only now.</Banner>
          <ol className="related-list" aria-label="Recovery codes">
            {recovery.map((value) => (
              <li key={value}>
                <code>{value}</code>
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {status && !status.enabled && !setup ? (
        <>
          <p className="ui-muted">Two-factor authentication is off. When it is on, signing in also needs a 6-digit code from an authenticator app on your phone.</p>
          <Button type="button" variant="primary" busy={busy} onClick={() => void start()}>
            Set Up
          </Button>
        </>
      ) : null}
      {setup ? (
        <>
          <p className="ui-muted">Add an account in your authenticator app with this key (time-based, 6 digits), or paste the setup link if the app accepts one. Then enter the code the app shows.</p>
          <div className="ui-field">
            <span>Key</span>
            <code className="form-value">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
          </div>
          <div className="ui-field">
            <span>Setup link</span>
            <code className="form-value" style={{ wordBreak: 'break-all' }}>
              {setup.uri}
            </code>
          </div>
          <TextField label="Code from the app" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          <Button type="button" variant="primary" busy={busy} disabled={!/^\d{6}$/.test(code.trim())} onClick={() => void enable()}>
            Turn On
          </Button>
        </>
      ) : null}
      {status?.enabled ? (
        <>
          <p className="ui-muted">Two-factor authentication is on. {status.recoveryCodesRemaining} unused recovery codes remain.</p>
          <div className="form-section">Turn Off</div>
          <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <TextField label="Authenticator or recovery code" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
          <Button type="button" busy={busy} disabled={!password || !code.trim()} onClick={() => void disable()}>
            Turn Off
          </Button>
        </>
      ) : null}
    </FormWindow>
  );
}
