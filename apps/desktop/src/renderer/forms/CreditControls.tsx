import { useEffect, useRef, useState } from 'react';
import type { ApiErrorBody, CreditDecision, CreditLimitFailure, CreditSettings } from '@nec/contracts';
import { Banner, Button, FormWindow } from '@nec/ui';
import { errorMessage } from '../api';
import { formatAmount } from '../format';
import type { ApiCall } from '../screens/Shell';

function CreditDecisionPanel({ failure, resolve }: { failure: CreditLimitFailure; resolve: (decision: CreditDecision | null) => void }) {
  const [reason, setReason] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const { exposure, mode } = failure;
  return <dialog ref={dialog} className="credit-dialog" aria-label="Credit limit exceeded" onKeyDown={(event) => event.stopPropagation()} onCancel={(event) => { event.preventDefault(); resolve(null); }}>
    <FormWindow title="Credit Limit Exceeded" width={620} onClose={() => resolve(null)}>
    <p>Account balance: {formatAmount(exposure.balance)} · Open orders: {formatAmount(exposure.openOrders)} · Uninvoiced deliveries: {formatAmount(exposure.uninvoicedDeliveries)}</p>
    <p>Resulting exposure: {formatAmount(exposure.total)} · Credit limit: {formatAmount(exposure.creditLimit)} · Remaining: {formatAmount(exposure.remaining)}</p>
    {mode === 'block' ? <label className="ui-field"><span>Override reason</span><input className="grid-input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label> : <p>The company policy allows you to acknowledge this warning and continue.</p>}
    <Button type="button" variant="primary" disabled={mode === 'block' && !reason.trim()} onClick={() => resolve(mode === 'warn' ? { creditAcknowledged: true } : { creditOverrideReason: reason.trim() })}>{mode === 'warn' ? 'Acknowledge and Continue' : 'Override and Continue'}</Button>
    <Button type="button" onClick={() => resolve(null)}>Cancel Posting</Button>
    </FormWindow>
  </dialog>;
}

export function useCreditSubmission(call: ApiCall) {
  const [pending, setPending] = useState<{ failure: CreditLimitFailure; resolve: (value: CreditDecision | null) => void } | null>(null);
  const retry = useRef<{ original: string; decision: CreditDecision } | null>(null);
  const cancelPending = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelPending.current?.(), []);
  const post = async <T,>(path: string, body: Record<string, unknown>) => {
    const original = JSON.stringify({ path, body });
    const decision = retry.current?.original === original ? retry.current.decision : {};
    const result = await call<T>('POST', path, { ...body, ...decision });
    const error = (result.body as unknown as Partial<ApiErrorBody> | null)?.error;
    if (result.ok || error?.code !== 'CREDIT_LIMIT_EXCEEDED') return result;
    const failure = error.details as CreditLimitFailure;
    if (failure.mode === 'block' && !failure.canOverride) return result;
    const next = await new Promise<CreditDecision | null>((resolve) => {
      cancelPending.current = () => resolve(null);
      setPending({ failure, resolve });
    });
    cancelPending.current = null;
    if (!next) return result;
    retry.current = { original, decision: next };
    return call<T>('POST', path, { ...body, ...next });
  };
  const panel = pending ? <CreditDecisionPanel failure={pending.failure} resolve={(value) => { pending.resolve(value); setPending(null); }} /> : null;
  return { post, panel };
}

export function CreditSettingsForm({ call, canAdminister, onClose }: { call: ApiCall; canAdminister: boolean; onClose: () => void }) {
  const [settings, setSettings] = useState<CreditSettings | null>(null);
  const [mode, setMode] = useState<CreditSettings['mode']>('disabled');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void call<CreditSettings>('GET', '/v1/sal/credit-settings').then((result) => {
      if (result.ok) { setSettings(result.body); setMode(result.body.mode); } else setError(errorMessage(result));
    });
  }, [call]);
  const save = async () => {
    if (!settings || busy || !canAdminister) return;
    setBusy(true); setError(null);
    const result = await call<CreditSettings>('PUT', '/v1/sal/credit-settings', { mode, version: settings.version });
    setBusy(false);
    if (result.ok) setSettings(result.body); else setError(errorMessage(result));
  };
  const dirty = settings && settings.mode !== mode;
  const close = () => { if (!busy && (!dirty || window.confirm('Discard credit policy changes?'))) onClose(); };
  return <FormWindow title="Sales Credit Policy" width={620} onClose={close} footerLeft={<>
    <Button type="button" variant="primary" busy={busy} disabled={!settings} onClick={() => dirty ? void save() : onClose()}>{dirty ? 'Update' : 'OK'}</Button><Button type="button" disabled={busy} onClick={close}>Cancel</Button>
  </>}>
    {error ? <Banner>{error}</Banner> : null}
    <label className="ui-field"><span>Credit limit policy</span><select className="grid-input" disabled={!canAdminister || busy || !settings} value={mode} onChange={(e) => setMode(e.target.value as CreditSettings['mode'])}><option value="disabled">Disabled</option><option value="warn">Warn and require acknowledgement</option><option value="block">Block unless an authorized user overrides</option></select></label>
    <p>Applies to sales orders, deliveries and A/R invoices, including orders copied from quotations. Set each customer's limit in Business Partner Master Data.</p>
    <p>Exposure includes the account balance, remaining open orders and uninvoiced deliveries. Pending orders and deliveries exclude tax. A zero limit permits no positive exposure.</p>
    <p>Warnings require acknowledgement. Overrides require permission and a reason. Both are recorded in the audit log. Cancellations and payments remain available to correct or reduce balances.</p>
  </FormWindow>;
}
