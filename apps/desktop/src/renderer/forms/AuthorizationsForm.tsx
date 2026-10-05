import { useCallback, useEffect, useMemo, useState } from 'react';
import { PERMISSIONS, type Role } from '@nec/contracts';
import { Banner, Button, FormWindow, TextField } from '@nec/ui';
import { errorMessage, fieldErrors } from '../api';
import type { ApiCall } from '../screens/Shell';

const MODULE_LABELS: Record<string, string> = {
  admin: 'Administration',
  bp: 'Business Partners',
  fin: 'Financials',
  inv: 'Inventory',
  pur: 'Purchasing - A/P',
  sal: 'Sales - A/R',
  bank: 'Banking',
};

interface Draft {
  id: string | null;
  code: string;
  name: string;
  permissions: string[];
}

export function AuthorizationsForm({ call, canAdminister, held, onClose }: { call: ApiCall; canAdminister: boolean; held: ReadonlySet<string>; onClose: () => void }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await call<Role[]>('GET', '/v1/tenant/roles');
    if (result.ok) setRoles(result.body);
    else setError(errorMessage(result));
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const permission of PERMISSIONS) {
      const module = permission.split('.')[0] ?? '';
      map.set(module, [...(map.get(module) ?? []), permission]);
    }
    return [...map.entries()];
  }, []);

  const selected = roles.find((role) => role.id === selectedId) ?? null;
  const shown = draft ?? (selected ? { id: selected.id, code: selected.code, name: selected.name, permissions: selected.permissions } : null);
  const editable = Boolean(draft) && canAdminister;

  const choose = (role: Role) => {
    if (draft && !window.confirm('Discard the unsaved role changes?')) return;
    setDraft(null);
    setFields({});
    setSelectedId(role.id);
  };

  const togglePermission = (permission: string, checked: boolean) =>
    setDraft((current) => (current ? { ...current, permissions: checked ? [...current.permissions, permission] : current.permissions.filter((value) => value !== permission) } : current));

  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = draft.id
      ? await call<Role>('PUT', `/v1/tenant/roles/${draft.id}`, { name: draft.name, permissions: draft.permissions })
      : await call<Role>('POST', '/v1/tenant/roles', { code: draft.code, name: draft.name, permissions: draft.permissions });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      setFields(fieldErrors(result));
      return;
    }
    setNotice(`Role ${result.body.name} saved.`);
    setDraft(null);
    setSelectedId(result.body.id);
    await load();
  };

  const remove = async () => {
    if (!selected || busy || !window.confirm(`Delete role ${selected.name}?`)) return;
    setBusy(true);
    setError(null);
    const result = await call('DELETE', `/v1/tenant/roles/${selected.id}`);
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setNotice(`Role ${selected.name} deleted.`);
    setSelectedId(null);
    await load();
  };

  return (
    <FormWindow
      title="Authorizations"
      width={980}
      onClose={onClose}
      footerLeft={
        draft ? (
          <>
            <Button type="button" variant="primary" busy={busy} disabled={!draft.name.trim() || draft.permissions.length === 0 || (!draft.id && !draft.code.trim())} onClick={() => void save()}>
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
          <>
            <Button type="button" onClick={() => setDraft({ id: null, code: '', name: '', permissions: [] })}>
              New Role
            </Button>
            {selected && !selected.isSystem ? (
              <>
                <Button type="button" onClick={() => setDraft({ id: selected.id, code: selected.code, name: selected.name, permissions: selected.permissions })}>
                  Edit Role
                </Button>
                <Button type="button" variant="danger" busy={busy} onClick={() => void remove()}>
                  Delete Role
                </Button>
              </>
            ) : null}
          </>
        ) : null
      }
    >
      {error ? <Banner>{error}</Banner> : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}
      <div className="form-columns">
        <div>
          <div className="form-section">Roles</div>
          <ul className="related-list" aria-label="Roles">
            {roles.map((role) => (
              <li key={role.id}>
                <Button type="button" variant={role.id === selectedId ? 'primary' : 'ghost'} onClick={() => choose(role)}>
                  {role.name}
                </Button>{' '}
                <span className="ui-muted">{role.isSystem ? 'system' : 'custom'} · {role.permissions.length} permissions</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          {shown ? (
            <>
              <div className="form-section">{draft && !draft.id ? 'New Role' : shown.name}</div>
              {draft ? (
                <div className="inline-fields">
                  {!draft.id ? <TextField label="Code" value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} error={fields.code} /> : null}
                  <TextField label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} error={fields.name} />
                </div>
              ) : null}
              {selected?.isSystem && !draft ? <p className="ui-muted">System roles are read-only. Create a custom role to adjust permissions.</p> : null}
              {groups.map(([module, permissions]) => (
                <div key={module}>
                  <div className="form-section">{MODULE_LABELS[module] ?? module}</div>
                  <div className="inline-fields">
                    {permissions.map((permission) => (
                      <label key={permission} className="flag-row" title={held.has(permission) ? undefined : 'You do not hold this permission'}>
                        <input
                          type="checkbox"
                          checked={shown.permissions.includes(permission)}
                          disabled={!editable || !held.has(permission)}
                          onChange={(e) => togglePermission(permission, e.target.checked)}
                        />{' '}
                        {permission.split('.').slice(1).join(' ')}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </>
          ) : (
            <p className="ui-muted">Choose a role to see its permissions.</p>
          )}
        </div>
      </div>
    </FormWindow>
  );
}
