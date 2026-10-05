import { useCallback, useEffect, useState } from 'react';
import type { SupportGrant } from '@nec/contracts';
import { Banner, Button, DataTable, FormWindow, StatusBadge } from '@nec/ui';
import { errorMessage } from '../api';
import type { ApiCall } from '../screens/Shell';

export function SupportAccessForm({ call, canAdminister, onClose }: { call: ApiCall; canAdminister: boolean; onClose: () => void }) {
  const [grants, setGrants] = useState<SupportGrant[]>([]);
  const [hours, setHours] = useState('4');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await call<SupportGrant[]>('GET', '/v1/tenant/support-access');
    if (result.ok) setGrants(result.body);
    else setError(errorMessage(result));
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const grant = async () => {
    if (busy || !reason.trim()) return;
    if (!window.confirm(`Allow platform support to view this company's data for ${hours} hours? Support cannot change data, and every access is logged.`)) return;
    setBusy(true);
    setError(null);
    const result = await call<SupportGrant>('POST', '/v1/tenant/support-access', { hours: Number(hours), reason: reason.trim() });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setReason('');
    setNotice(`Support access granted until ${new Date(result.body.expiresAt).toLocaleString()}.`);
    await load();
  };

  const revoke = async (row: SupportGrant) => {
    if (!window.confirm('Revoke this support access now? Open support sessions stop working immediately.')) return;
    setError(null);
    const result = await call('DELETE', `/v1/tenant/support-access/${row.id}`);
    if (!result.ok) setError(errorMessage(result));
    else setNotice('Support access revoked.');
    await load();
  };

  return (
    <FormWindow
      title="Support Access"
      width={820}
      onClose={onClose}
      footerLeft={
        <Button type="button" variant="primary" onClick={onClose}>
          OK
        </Button>
      }
    >
      {error ? <Banner>{error}</Banner> : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}
      <p className="ui-muted">
        Platform support can view this company's data only while an access grant is active. Support sessions are read-only, cannot use administration functions, and every request is logged in the platform audit.
      </p>
      <DataTable
        rowNumbers
        rows={grants}
        rowKey={(row) => row.id}
        empty="Support access has never been granted."
        columns={[
          { key: 'by', header: 'Granted By', render: (row) => row.grantedBy },
          { key: 'reason', header: 'Reason', render: (row) => row.reason },
          { key: 'from', header: 'Granted', render: (row) => new Date(row.createdAt).toLocaleString() },
          { key: 'to', header: 'Expires', render: (row) => new Date(row.expiresAt).toLocaleString() },
          { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.active ? 'active' : 'disabled'} /> },
          {
            key: 'action',
            header: '',
            render: (row) =>
              canAdminister && row.active ? (
                <Button type="button" variant="danger" onClick={() => void revoke(row)}>
                  Revoke
                </Button>
              ) : null,
          },
        ]}
      />
      {canAdminister ? (
        <>
          <div className="form-section">Grant Access</div>
          <div className="inline-fields">
            <label className="ui-field">
              <span>Duration</span>
              <select className="grid-input" aria-label="Support access duration" value={hours} onChange={(e) => setHours(e.target.value)}>
                {['1', '4', '8', '24', '72'].map((value) => (
                  <option key={value} value={value}>
                    {value} hours
                  </option>
                ))}
              </select>
            </label>
            <label className="ui-field">
              <span>Reason</span>
              <input className="grid-input" aria-label="Support access reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
            </label>
            <Button type="button" variant="primary" busy={busy} disabled={!reason.trim()} onClick={() => void grant()}>
              Grant
            </Button>
          </div>
        </>
      ) : null}
    </FormWindow>
  );
}
