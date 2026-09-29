import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Branch } from '@nec/contracts';
import { Banner, Button, DataTable, FormWindow, LinkArrow, StatusBadge } from '@nec/ui';
import { errorMessage, fieldErrors } from '../api';
import type { ApiCall } from '../screens/Shell';

export function BranchesForm({
  call,
  canCreate,
  canEdit,
  onClose,
}: {
  call: ApiCall;
  canCreate: boolean;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Branch | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await call<Branch[]>('GET', '/v1/tenant/branches');
    setLoading(false);
    if (result.ok) {
      setBranches(result.body);
    } else {
      setError(errorMessage(result));
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = code.trim() !== '' || name.trim() !== '';

  const add = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || !dirty) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await call<Branch>('POST', '/v1/tenant/branches', { code, name });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      setFields(fieldErrors(result));
      return;
    }
    setNotice(`Branch ${result.body.code} added.`);
    setCode('');
    setName('');
    setFields({});
    await load();
  };

  const toggle = async (branch: Branch) => {
    const next = branch.status === 'active' ? 'disabled' : 'active';
    if (next === 'disabled' && !window.confirm(`Deactivate branch ${branch.code}? It will not accept new documents.`)) {
      return;
    }
    setError(null);
    const result = await call<Branch>('PATCH', `/v1/tenant/branches/${branch.id}/status`, { status: next, version: branch.version });
    if (!result.ok) {
      setError(errorMessage(result));
    }
    await load();
  };

  const cancel = () => {
    if (dirty && !window.confirm('Discard the unsaved branch row?')) {
      return;
    }
    onClose();
  };

  return (
    <form onSubmit={add} noValidate>
      <FormWindow
        title="Branches - Setup"
        onClose={cancel}
        footerLeft={
          <>
            {canCreate && dirty ? (
              <Button type="submit" variant="primary" busy={busy}>
                Add
              </Button>
            ) : (
              <Button type="button" variant="primary" onClick={onClose}>
                OK
              </Button>
            )}
            <Button type="button" onClick={cancel}>
              Cancel
            </Button>
          </>
        }
      >
        {error ? <Banner>{error}</Banner> : null}
        {notice ? <Banner tone="info">{notice}</Banner> : null}
        <DataTable
          rowNumbers
          loading={loading}
          rows={branches}
          rowKey={(row) => row.id}
          empty="No branches."
          columns={[
            {
              key: 'code',
              header: 'Branch Code',
              render: (row) => (
                <>
                  <LinkArrow label={`Show branch ${row.code}`} onClick={() => setSelected(row)} />
                  {row.code}
                </>
              ),
            },
            { key: 'name', header: 'Branch Name', render: (row) => row.name },
            { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
            {
              key: 'active',
              header: 'Active',
              render: (row) => (
                <input
                  type="checkbox"
                  aria-label={`Branch ${row.code} active`}
                  checked={row.status === 'active'}
                  disabled={!canEdit}
                  onChange={() => toggle(row)}
                />
              ),
            },
          ]}
          footerRow={
            canCreate ? (
              <tr className="new-row">
                <td className="ui-table__row-number">*</td>
                <td>
                  <input
                    className="grid-input"
                    aria-label="New branch code"
                    maxLength={20}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    aria-invalid={fields.code ? true : undefined}
                    title={fields.code}
                  />
                </td>
                <td>
                  <input
                    className="grid-input"
                    aria-label="New branch name"
                    maxLength={120}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    aria-invalid={fields.name ? true : undefined}
                    title={fields.name}
                  />
                </td>
                <td />
                <td />
              </tr>
            ) : undefined
          }
        />
        {canCreate ? <p className="ui-muted">Type a code and name in the row marked *, then choose Add.</p> : null}
        {selected ? (
          <>
            <div className="form-section">Branch {selected.code}</div>
            <div className="form-columns">
              <div className="ui-field">
                <span>Code</span>
                <span className="form-value">{selected.code}</span>
              </div>
              <div className="ui-field">
                <span>Name</span>
                <span className="form-value">{selected.name}</span>
              </div>
              <div className="ui-field">
                <span>Status</span>
                <span className="form-value">{selected.status}</span>
              </div>
              <div className="ui-field">
                <span>Version</span>
                <span className="form-value">{selected.version}</span>
              </div>
            </div>
          </>
        ) : null}
      </FormWindow>
    </form>
  );
}
