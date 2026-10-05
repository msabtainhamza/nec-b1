import { useCallback, useEffect, useState } from 'react';
import type { ApprovalRequestSummary, ApprovalTemplate, PurchaseOrder, Role, SalesOrder } from '@nec/contracts';
import { Banner, Button, DataTable, FormWindow, StatusBadge, TextField } from '@nec/ui';
import { errorMessage, fieldErrors } from '../api';
import { formatAmount } from '../format';
import type { ApiCall } from '../screens/Shell';
import { useCreditSubmission } from './CreditControls';

const DOCUMENT_LABELS = { sales_order: 'Sales Order', purchase_order: 'Purchase Order' } as const;
const SCOPES = [
  { scope: 'to_decide', label: 'To Decide' },
  { scope: 'mine', label: 'My Requests' },
  { scope: 'all', label: 'All Requests' },
] as const;

export function ApprovalsForm({ call, onClose }: { call: ApiCall; onClose: () => void }) {
  const [scope, setScope] = useState<(typeof SCOPES)[number]['scope']>('to_decide');
  const [rows, setRows] = useState<ApprovalRequestSummary[]>([]);
  const [selected, setSelected] = useState<ApprovalRequestSummary | null>(null);
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const credit = useCreditSubmission(call);

  const load = useCallback(async () => {
    const result = await call<ApprovalRequestSummary[]>('GET', `/v1/tenant/approvals?scope=${scope}`);
    if (result.ok) setRows(result.body);
    else setError(errorMessage(result));
  }, [call, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async (updated?: ApprovalRequestSummary) => {
    setSelected(updated ?? null);
    setRemarks('');
    await load();
  };

  const decide = async (decision: 'approved' | 'rejected') => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    const result = await call<ApprovalRequestSummary>('POST', `/v1/tenant/approvals/${selected.id}/decision`, { decision, remarks: remarks.trim() || undefined, version: selected.version });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setNotice(`Request ${decision}. Status: ${result.body.status}.`);
    await refresh(result.body);
  };

  const cancel = async () => {
    if (!selected || busy || !window.confirm('Cancel this approval request?')) return;
    setBusy(true);
    const result = await call<ApprovalRequestSummary>('POST', `/v1/tenant/approvals/${selected.id}/cancel`, {});
    setBusy(false);
    if (!result.ok) setError(errorMessage(result));
    else {
      setNotice('Approval request cancelled.');
      await refresh(result.body);
    }
  };

  const complete = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    const result = await credit.post<{ request: ApprovalRequestSummary; document: SalesOrder | PurchaseOrder }>(`/v1/tenant/approvals/${selected.id}/complete`, {});
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setNotice(`${DOCUMENT_LABELS[selected.documentType]} ${result.body.document.documentNumber} added.`);
    await refresh(result.body.request);
  };

  return (
    <FormWindow
      title="Approvals"
      width={980}
      onClose={onClose}
      footerLeft={
        <Button type="button" variant="primary" onClick={onClose}>
          OK
        </Button>
      }
    >
      {credit.panel}
      {error ? <Banner>{error}</Banner> : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}
      <div className="inline-fields">
        {SCOPES.map((entry) => (
          <Button key={entry.scope} type="button" variant={entry.scope === scope ? 'primary' : 'ghost'} onClick={() => setScope(entry.scope)}>
            {entry.label}
          </Button>
        ))}
      </div>
      <DataTable
        rowNumbers
        rows={rows}
        rowKey={(row) => row.id}
        empty={scope === 'to_decide' ? 'Nothing is waiting for your decision.' : 'No approval requests.'}
        columns={[
          { key: 'type', header: 'Document', render: (row) => DOCUMENT_LABELS[row.documentType] },
          { key: 'partner', header: 'Business Partner', render: (row) => `${row.partnerCode} - ${row.partnerName}` },
          { key: 'total', header: 'Total', render: (row) => formatAmount(row.total) },
          { key: 'originator', header: 'Originator', render: (row) => row.originatorName },
          { key: 'template', header: 'Template', render: (row) => row.templateName },
          { key: 'approvals', header: 'Approvals', render: (row) => `${row.approvals} of ${row.requiredApprovals}` },
          { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
          {
            key: 'open',
            header: '',
            render: (row) => (
              <Button type="button" variant="ghost" onClick={() => setSelected(row)}>
                Open
              </Button>
            ),
          },
        ]}
      />
      {selected ? (
        <div className="reverse-panel">
          <div className="form-section">
            {DOCUMENT_LABELS[selected.documentType]} for {selected.partnerName}: {formatAmount(selected.total)} · {selected.status}
            {selected.documentNumber ? ` · ${selected.documentNumber}` : ''}
          </div>
          {selected.decisions.length > 0 ? (
            <ul className="related-list" aria-label="Decisions">
              {selected.decisions.map((decision) => (
                <li key={`${decision.approverName}-${decision.decidedAt}`}>
                  {decision.approverName}: {decision.decision} on {new Date(decision.decidedAt).toLocaleString()}
                  {decision.remarks ? ` · ${decision.remarks}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className="ui-muted">No decisions yet.</p>
          )}
          {selected.canDecide ? (
            <div className="inline-fields">
              <TextField label="Remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
              <Button type="button" variant="primary" busy={busy} onClick={() => void decide('approved')}>
                Approve
              </Button>
              <Button type="button" variant="danger" busy={busy} onClick={() => void decide('rejected')}>
                Reject
              </Button>
            </div>
          ) : null}
          <div className="inline-fields">
            {selected.status === 'approved' ? (
              <Button type="button" variant="primary" busy={busy} onClick={() => void complete()}>
                Add Document
              </Button>
            ) : null}
            {selected.status === 'pending' || selected.status === 'approved' ? (
              <Button type="button" busy={busy} onClick={() => void cancel()}>
                Cancel Request
              </Button>
            ) : null}
          </div>
          <p className="ui-muted">Only the originator can add or cancel the document. Approvers cannot decide on documents they submitted.</p>
        </div>
      ) : null}
    </FormWindow>
  );
}

interface TemplateDraft {
  id: string | null;
  name: string;
  documentType: 'sales_order' | 'purchase_order';
  minTotal: string;
  approverRoleId: string;
  requiredApprovals: string;
  active: boolean;
  version: number;
}

export function ApprovalTemplatesForm({ call, canAdminister, onClose }: { call: ApiCall; canAdminister: boolean; onClose: () => void }) {
  const [templates, setTemplates] = useState<ApprovalTemplate[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const [t, r] = await Promise.all([call<ApprovalTemplate[]>('GET', '/v1/tenant/approval-templates'), call<Role[]>('GET', '/v1/tenant/roles')]);
    if (t.ok) setTemplates(t.body);
    else setError(errorMessage(t));
    if (r.ok) setRoles(r.body);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    const body = { name: draft.name, documentType: draft.documentType, minTotal: draft.minTotal.replace(/,/g, '').trim() || '0', approverRoleId: draft.approverRoleId, requiredApprovals: Number(draft.requiredApprovals), active: draft.active };
    const result = draft.id ? await call<ApprovalTemplate>('PUT', `/v1/tenant/approval-templates/${draft.id}`, { ...body, version: draft.version }) : await call<ApprovalTemplate>('POST', '/v1/tenant/approval-templates', body);
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      setFields(fieldErrors(result));
      return;
    }
    setNotice(`Approval template ${result.body.name} saved.`);
    setDraft(null);
    setFields({});
    await load();
  };

  return (
    <FormWindow
      title="Approval Templates"
      width={900}
      onClose={onClose}
      footerLeft={
        draft ? (
          <>
            <Button type="button" variant="primary" busy={busy} disabled={!draft.name.trim() || !draft.approverRoleId} onClick={() => void save()}>
              {draft.id ? 'Update' : 'Add'}
            </Button>
            <Button type="button" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button type="button" variant="primary" onClick={onClose}>
            OK
          </Button>
        )
      }
      footerRight={
        canAdminister && !draft ? (
          <Button type="button" onClick={() => setDraft({ id: null, name: '', documentType: 'sales_order', minTotal: '0', approverRoleId: '', requiredApprovals: '1', active: true, version: 0 })}>
            New Template
          </Button>
        ) : null
      }
    >
      {error ? <Banner>{error}</Banner> : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}
      <DataTable
        rowNumbers
        rows={templates}
        rowKey={(row) => row.id}
        empty="No approval templates. Documents are added without approval."
        columns={[
          { key: 'name', header: 'Name', render: (row) => row.name },
          { key: 'type', header: 'Document', render: (row) => DOCUMENT_LABELS[row.documentType] },
          { key: 'min', header: 'Total from', render: (row) => formatAmount(row.minTotal) },
          { key: 'role', header: 'Approvers', render: (row) => row.approverRoleName },
          { key: 'required', header: 'Approvals', render: (row) => row.requiredApprovals },
          { key: 'active', header: 'Active', render: (row) => <StatusBadge status={row.active ? 'active' : 'disabled'} /> },
          {
            key: 'edit',
            header: '',
            render: (row) =>
              canAdminister ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setDraft({ id: row.id, name: row.name, documentType: row.documentType, minTotal: row.minTotal, approverRoleId: row.approverRoleId, requiredApprovals: String(row.requiredApprovals), active: row.active, version: row.version })}
                >
                  Edit
                </Button>
              ) : null,
          },
        ]}
      />
      {draft ? (
        <div className="reverse-panel">
          <div className="form-section">{draft.id ? 'Edit Template' : 'New Template'}</div>
          <div className="inline-fields">
            <TextField label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} error={fields.name} />
            <label className="ui-field">
              <span>Document</span>
              <select className="grid-input" aria-label="Document type" value={draft.documentType} onChange={(e) => setDraft({ ...draft, documentType: e.target.value as TemplateDraft['documentType'] })}>
                <option value="sales_order">Sales Order</option>
                <option value="purchase_order">Purchase Order</option>
              </select>
            </label>
            <TextField label="Document total from" inputMode="decimal" value={draft.minTotal} onChange={(e) => setDraft({ ...draft, minTotal: e.target.value })} error={fields.minTotal} />
            <label className="ui-field">
              <span>Approver role</span>
              <select className="grid-input" aria-label="Approver role" value={draft.approverRoleId} onChange={(e) => setDraft({ ...draft, approverRoleId: e.target.value })}>
                <option value="">Select a role</option>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="ui-field">
              <span>Approvals required</span>
              <select className="grid-input" aria-label="Approvals required" value={draft.requiredApprovals} onChange={(e) => setDraft({ ...draft, requiredApprovals: e.target.value })}>
                {['1', '2', '3', '4', '5'].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="flag-row">
              <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} /> Active
            </label>
          </div>
          <p className="ui-muted">A new document whose total before tax is at least this amount is sent for approval by members of the approver role instead of being added. When several templates match, the one with the highest amount applies. Approvers can never approve their own documents.</p>
        </div>
      ) : null}
    </FormWindow>
  );
}
