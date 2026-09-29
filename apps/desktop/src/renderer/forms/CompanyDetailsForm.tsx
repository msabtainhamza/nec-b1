import type { TenantContextResponse } from '@nec/contracts';
import { Button, FormWindow } from '@nec/ui';

function Field({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="ui-field">
      <span>{label}</span>
      <span className="form-value">{value}</span>
    </div>
  );
}

export function CompanyDetailsForm({ context, onClose }: { context: TenantContextResponse | null; onClose: () => void }) {
  return (
    <FormWindow title="Company Details" onClose={onClose} footerLeft={<Button variant="primary" onClick={onClose}>OK</Button>}>
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
          <p className="ui-muted">
            Sales - A/R, Banking (payments), stock transfers and adjustments, and Reports are planned for milestones M3 to M5.
          </p>
        </>
      )}
    </FormWindow>
  );
}
