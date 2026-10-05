import { useEffect, useState } from 'react';
import type { CompanyProfile, SecuritySettings, TenantContextResponse } from '@nec/contracts';
import { Banner, Button, FormWindow } from '@nec/ui';
import { errorMessage } from '../api';
import type { ApiCall } from '../screens/Shell';

type ProfileDraft = Omit<CompanyProfile, 'version'>;

const PROFILE_FIELDS: { key: keyof ProfileDraft; label: string; maxLength: number }[] = [
  { key: 'street', label: 'Street', maxLength: 200 },
  { key: 'city', label: 'City', maxLength: 100 },
  { key: 'state', label: 'State', maxLength: 100 },
  { key: 'zipCode', label: 'Zip Code', maxLength: 20 },
  { key: 'country', label: 'Country', maxLength: 100 },
  { key: 'taxNumber', label: 'Tax Number', maxLength: 50 },
  { key: 'phone', label: 'Telephone', maxLength: 50 },
  { key: 'email', label: 'E-Mail', maxLength: 200 },
];

const toDraft = (profile: CompanyProfile): ProfileDraft => ({
  street: profile.street,
  city: profile.city,
  state: profile.state,
  zipCode: profile.zipCode,
  country: profile.country,
  taxNumber: profile.taxNumber,
  phone: profile.phone,
  email: profile.email,
  invoiceFooter: profile.invoiceFooter,
});

function Field({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="ui-field">
      <span>{label}</span>
      <span className="form-value">{value}</span>
    </div>
  );
}

export function CompanyDetailsForm({
  context,
  call,
  canViewProfile,
  canEditProfile,
  canEditSecurity,
  canExport,
  onClose,
}: {
  context: TenantContextResponse | null;
  call: ApiCall;
  canViewProfile: boolean;
  canEditProfile: boolean;
  canEditSecurity: boolean;
  canExport: boolean;
  onClose: () => void;
}) {
  const [security, setSecurity] = useState<SecuritySettings | null>(null);
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!canViewProfile) return;
    void call<CompanyProfile>('GET', '/v1/tenant/company-profile').then((result) => {
      if (result.ok) {
        setProfile(result.body);
        setDraft(toDraft(result.body));
      } else {
        setError(errorMessage(result));
      }
    });
    void call<SecuritySettings>('GET', '/v1/tenant/security-settings').then((result) => {
      if (result.ok) setSecurity(result.body);
    });
  }, [call, canViewProfile]);

  const dirty = profile !== null && draft !== null && JSON.stringify(toDraft(profile)) !== JSON.stringify(draft);

  const save = async () => {
    if (!profile || !draft || busy) return;
    setBusy(true);
    setError(null);
    const result = await call<CompanyProfile>('PUT', '/v1/tenant/company-profile', { ...draft, version: profile.version });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setProfile(result.body);
    setDraft(toDraft(result.body));
    setNotice('Operation completed successfully.');
  };

  const toggleAdminMfa = async (requireAdminMfa: boolean) => {
    if (!security || busy) return;
    if (requireAdminMfa && !window.confirm('Require two-factor authentication for every user who administers this company? Administrators without it cannot open the company until they set it up.')) return;
    setBusy(true);
    setError(null);
    const result = await call<SecuritySettings>('PUT', '/v1/tenant/security-settings', { requireAdminMfa, version: security.version });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setSecurity(result.body);
    setNotice('Operation completed successfully.');
  };

  const exportData = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.erp.exportCompany();
      if (result.saved) setNotice('Company data exported.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'The company data could not be exported.');
    } finally {
      setBusy(false);
    }
  };

  const requestDeletion = async () => {
    if (!context || busy) return;
    const confirmCode = window.prompt(`Requesting deletion makes ${context.tenant.displayName} read-only for everyone except export. The platform operator then completes or cancels the request. Type the company code (${context.tenant.code}) to confirm:`);
    if (!confirmCode) return;
    const reason = window.prompt('Reason for the deletion request:');
    if (!reason?.trim()) return;
    setBusy(true);
    setError(null);
    const result = await call('POST', '/v1/tenant/deletion-request', { confirmCode: confirmCode.trim(), reason: reason.trim() });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setNotice('Deletion requested. The company is now read-only; export your data and contact support to complete or withdraw the request.');
  };

  const setValue = (key: keyof ProfileDraft, value: string) => setDraft((current) => (current ? { ...current, [key]: value } : current));

  return (
    <FormWindow
      title="Company Details"
      onClose={onClose}
      footerLeft={
        <>
          <Button variant="primary" busy={busy} onClick={() => (dirty ? void save() : onClose())}>
            {dirty ? 'Update' : 'OK'}
          </Button>
          {dirty ? <Button onClick={onClose}>Cancel</Button> : null}
        </>
      }
    >
      {error ? <Banner>{error}</Banner> : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}
      {!context ? (
        <p className="ui-muted" role="status">Loading company…</p>
      ) : (
        <>
          <div className="form-section">General</div>
          <div className="form-columns">
            <div>
              <Field label="Company Name" value={context.tenant.legalName} />
              <Field label="Display Name" value={context.tenant.displayName} />
              <Field label="Company Code" value={context.tenant.code} />
            </div>
            <div>
              <Field label="Local Currency" value={context.tenant.baseCurrency} />
              <Field label="Time Zone" value={context.tenant.timeZone} />
              <Field label="Subscription" value={context.subscription.state.replaceAll('_', ' ')} />
            </div>
          </div>
          {draft ? (
            <>
              <div className="form-section">Address and Tax Details for Printed Documents</div>
              <div className="form-columns">
                {[PROFILE_FIELDS.slice(0, 5), PROFILE_FIELDS.slice(5)].map((column, index) => (
                  <div key={index}>
                    {column.map((field) => (
                      <label key={field.key} className="ui-field">
                        <span>{field.label}</span>
                        <input className="grid-input" value={draft[field.key] ?? ''} maxLength={field.maxLength} readOnly={!canEditProfile} onChange={(e) => setValue(field.key, e.target.value)} />
                      </label>
                    ))}
                  </div>
                ))}
              </div>
              <label className="ui-field">
                <span>Invoice Footer</span>
                <textarea className="grid-input" rows={3} value={draft.invoiceFooter ?? ''} maxLength={1000} readOnly={!canEditProfile} onChange={(e) => setValue('invoiceFooter', e.target.value)} />
              </label>
              <p className="ui-muted">
                Printed A/R invoices show these details as they were when each invoice was posted. Required statutory invoice fields depend on the country and have not been validated for any jurisdiction.
              </p>
            </>
          ) : null}
          {security ? (
            <>
              <div className="form-section">Security</div>
              <label className="flag-row">
                <input type="checkbox" checked={security.requireAdminMfa} disabled={!canEditSecurity || busy} onChange={(e) => void toggleAdminMfa(e.target.checked)} /> Require two-factor authentication for administrators
              </label>
              <p className="ui-muted">Applies to users who can administer users of this company. Turn on two-factor authentication for your own account first (Administration &gt; Utilities &gt; Two-Factor Authentication).</p>
            </>
          ) : null}
          <div className="form-section">Plan Limits</div>
          <div className="form-columns">
            <div>
              <Field label="Active Seats" value={context.entitlements.maxActiveSeats} />
              <Field label="Branches" value={context.entitlements.maxBranches} />
            </div>
            <div>
              <Field label="Employee Records" value={context.entitlements.maxEmployees} />
              <Field label="Modules" value={context.entitlements.modules.join(', ') || 'None'} />
            </div>
          </div>
          {canExport ? (
            <>
              <div className="form-section">Company Data</div>
              <div className="inline-fields">
                <Button type="button" busy={busy} onClick={() => void exportData()}>
                  Export Company Data
                </Button>
                <Button type="button" variant="danger" disabled={busy} onClick={() => void requestDeletion()}>
                  Request Deletion
                </Button>
              </div>
              <p className="ui-muted">The export contains every record of this company as JSON, without passwords, tokens or two-factor secrets. Deletion is completed by the platform operator after the request.</p>
            </>
          ) : null}
        </>
      )}
    </FormWindow>
  );
}
