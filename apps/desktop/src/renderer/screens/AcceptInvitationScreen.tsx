import { useState, type FormEvent } from 'react';
import { Banner, Button, FormWindow, TextField } from '@nec/ui';
import { errorMessage, fieldErrors } from '../api';

export function AcceptInvitationScreen({ onDone, onCancel }: { onDone: (message: string) => void; onCancel: () => void }) {
  const [token, setToken] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    const result = await window.erp.acceptInvitation({
      token: token.trim(),
      password,
      displayName: displayName.trim() || undefined,
    });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      setFields(fieldErrors(result));
      return;
    }
    onDone('Invitation accepted. Log on with your email and password.');
  };

  return (
    <main className="dialog-layout">
      <form onSubmit={submit} noValidate>
        <FormWindow
          title="Accept Invitation"
          onClose={onCancel}
          footerLeft={
            <>
              <Button type="submit" variant="primary" busy={busy} disabled={!token || !password}>
                OK
              </Button>
              <Button type="button" onClick={onCancel}>
                Cancel
              </Button>
            </>
          }
        >
          <p className="ui-muted">Paste the code from your invitation email. Existing users enter their current password.</p>
          {error ? <Banner>{error}</Banner> : null}
          <TextField label="Invitation code" required value={token} onChange={(e) => setToken(e.target.value)} error={fields.token} autoFocus />
          <TextField
            label="Your name"
            hint="Required for a new account."
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            error={fields.displayName}
          />
          <TextField
            label="Password"
            type="password"
            autoComplete="new-password"
            required
            hint="At least 12 characters."
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={fields.password}
          />
        </FormWindow>
      </form>
    </main>
  );
}
