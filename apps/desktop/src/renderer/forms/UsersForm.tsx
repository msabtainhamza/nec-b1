import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Member, Role } from '@nec/contracts';
import { Banner, Button, DataTable, FormWindow, StatusBadge, TextField } from '@nec/ui';
import { errorMessage, fieldErrors } from '../api';
import type { ApiCall } from '../screens/Shell';

interface Invitation {
  id: string;
  email: string;
  expiresAt: string;
}

export function UsersForm({
  call,
  canInvite,
  canAdminister,
  currentMembershipId,
  onClose,
}: {
  call: ApiCall;
  canInvite: boolean;
  canAdminister: boolean;
  currentMembershipId: string;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [memberResult, invitationResult, roleResult] = await Promise.all([
      call<Member[]>('GET', '/v1/tenant/members'),
      call<Invitation[]>('GET', '/v1/tenant/invitations'),
      call<Role[]>('GET', '/v1/tenant/roles'),
    ]);
    setLoading(false);
    if (memberResult.ok) {
      setMembers(memberResult.body);
    } else {
      setError(errorMessage(memberResult));
    }
    if (invitationResult.ok) {
      setInvitations(invitationResult.body);
    }
    if (roleResult.ok) {
      setRoles(roleResult.body);
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = email.trim() !== '';

  const invite = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || !email || !roleId) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await call('POST', '/v1/tenant/invitations', { email, roleIds: [roleId] });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      setFields(fieldErrors(result));
      return;
    }
    setNotice(`Invitation emailed to ${email}.`);
    setEmail('');
    setFields({});
    await load();
  };

  const toggle = async (member: Member) => {
    const next = member.status === 'active' ? 'disabled' : 'active';
    if (next === 'disabled' && !window.confirm(`Lock user ${member.displayName}? They will lose access immediately.`)) {
      return;
    }
    setError(null);
    const result = await call('PATCH', `/v1/tenant/members/${member.membershipId}/status`, { status: next, version: member.version });
    if (!result.ok) {
      setError(errorMessage(result));
    }
    await load();
  };

  const revoke = async (invitation: Invitation) => {
    if (!window.confirm(`Revoke the invitation for ${invitation.email}?`)) {
      return;
    }
    const result = await call('DELETE', `/v1/tenant/invitations/${invitation.id}`);
    if (!result.ok) {
      setError(errorMessage(result));
    }
    await load();
  };

  const cancel = () => {
    if (dirty && !window.confirm('Discard the unsent invitation?')) {
      return;
    }
    onClose();
  };

  return (
    <form onSubmit={invite} noValidate>
      <FormWindow
        title="Users - Setup"
        onClose={cancel}
        footerLeft={
          <>
            {canInvite && dirty ? (
              <Button type="submit" variant="primary" busy={busy} disabled={!roleId}>
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
          rows={members}
          rowKey={(row) => row.membershipId}
          empty="No users."
          columns={[
            { key: 'name', header: 'User Name', render: (row) => row.displayName },
            { key: 'email', header: 'User ID (email)', render: (row) => row.email },
            { key: 'roles', header: 'Roles', render: (row) => row.roles.join(', ') },
            { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
            {
              key: 'locked',
              header: 'Locked',
              render: (row) => (
                <input
                  type="checkbox"
                  aria-label={`User ${row.displayName} locked`}
                  checked={row.status !== 'active'}
                  disabled={!canAdminister || row.membershipId === currentMembershipId || row.status === 'revoked'}
                  onChange={() => toggle(row)}
                />
              ),
            },
          ]}
        />
        <div className="form-section">Pending Invitations</div>
        <DataTable
          rowNumbers
          loading={loading}
          rows={invitations}
          rowKey={(row) => row.id}
          empty="No pending invitations."
          columns={[
            { key: 'email', header: 'Email', render: (row) => row.email },
            { key: 'expires', header: 'Expires', render: (row) => new Date(row.expiresAt).toLocaleString() },
            {
              key: 'actions',
              header: '',
              render: (row) =>
                canInvite ? (
                  <Button type="button" variant="danger" onClick={() => revoke(row)}>
                    Revoke
                  </Button>
                ) : null,
            },
          ]}
        />
        {canInvite ? (
          <>
            <div className="form-section">Invite User</div>
            <div className="inline-fields">
              <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={fields.email} />
              <div className="ui-field">
                <label htmlFor="invite-role">Role</label>
                <select id="invite-role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                  <option value="">Select a role</option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </>
        ) : null}
      </FormWindow>
    </form>
  );
}
