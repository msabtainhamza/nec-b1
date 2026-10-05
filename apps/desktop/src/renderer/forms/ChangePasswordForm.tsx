import { useState, type FormEvent } from 'react';
import { Banner, Button, FormWindow, TextField } from '@nec/ui';
import { errorMessage, fieldErrors } from '../api';

export function ChangePasswordForm({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    if (next !== confirm) {
      setFields({ confirm: 'The passwords do not match' });
      return;
    }
    setBusy(true);
    setFields({});
    const result = await window.erp.changePassword(current, next);
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      setFields(fieldErrors(result));
      return;
    }
    setCurrent('');
    setNext('');
    setConfirm('');
    setNotice('Password changed. Your other sessions were signed out; this one stays signed in.');
  };

  return (
    <form onSubmit={submit} noValidate>
      <FormWindow
        title="Change Password"
        width={460}
        onClose={onClose}
        footerLeft={
          <>
            <Button type="submit" variant="primary" busy={busy} disabled={!current || !next || !confirm}>
              Change
            </Button>
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
          </>
        }
      >
        {notice ? <Banner tone="info">{notice}</Banner> : null}
        {error ? <Banner>{error}</Banner> : null}
        <TextField label="Current password" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
        <TextField label="New password" type="password" autoComplete="new-password" required hint="At least 12 characters." value={next} onChange={(e) => setNext(e.target.value)} error={fields.newPassword} />
        <TextField label="Confirm new password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} error={fields.confirm} />
      </FormWindow>
    </form>
  );
}
