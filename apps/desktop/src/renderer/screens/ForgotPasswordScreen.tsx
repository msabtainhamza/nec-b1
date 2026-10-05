import { useState, type FormEvent } from 'react';
import { Banner, Button, FormWindow, TextField } from '@nec/ui';
import { errorMessage, fieldErrors } from '../api';

export function ForgotPasswordScreen({ onDone, onCancel }: { onDone: (message: string) => void; onCancel: () => void }) {
  const [step, setStep] = useState<'request' | 'reset'>('request');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const request = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !email.trim()) return;
    setBusy(true);
    setError(null);
    const result = await window.erp.requestPasswordReset(email.trim());
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setNotice('If an active account uses this email, a reset code has been sent to it. The code expires after a short time and can be used once.');
    setStep('reset');
  };

  const reset = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (password !== confirm) {
      setFields({ confirm: 'The passwords do not match' });
      return;
    }
    setBusy(true);
    setError(null);
    setFields({});
    const result = await window.erp.confirmPasswordReset(token.trim(), password);
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      setFields(fieldErrors(result));
      return;
    }
    onDone('Your password has been reset and all your sessions were signed out. Log on with the new password.');
  };

  return (
    <main className="dialog-layout">
      <form onSubmit={step === 'request' ? request : reset} noValidate>
        <FormWindow
          title="Forgot Password"
          onClose={onCancel}
          footerLeft={
            <>
              <Button type="submit" variant="primary" busy={busy} disabled={step === 'request' ? !email.trim() : !token || !password || !confirm}>
                {step === 'request' ? 'Send Code' : 'Reset Password'}
              </Button>
              <Button type="button" onClick={onCancel}>
                Cancel
              </Button>
            </>
          }
          footerRight={
            step === 'request' ? (
              <Button type="button" onClick={() => setStep('reset')}>
                I Have a Code
              </Button>
            ) : null
          }
        >
          {notice ? <Banner tone="info">{notice}</Banner> : null}
          {error ? <Banner>{error}</Banner> : null}
          {step === 'request' ? (
            <TextField label="User ID (email)" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          ) : (
            <>
              <TextField label="Reset code" required value={token} onChange={(e) => setToken(e.target.value)} error={fields.token} autoFocus />
              <TextField label="New password" type="password" autoComplete="new-password" required hint="At least 12 characters." value={password} onChange={(e) => setPassword(e.target.value)} error={fields.password} />
              <TextField label="Confirm new password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} error={fields.confirm} />
            </>
          )}
        </FormWindow>
      </form>
    </main>
  );
}
