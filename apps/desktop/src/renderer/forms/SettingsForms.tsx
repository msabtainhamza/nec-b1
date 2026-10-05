import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { PurchasingSettings, SalesSettings, TaxCode } from '@nec/contracts';
import { Banner, Button, DataTable, FormWindow, StatusBadge } from '@nec/ui';
import { errorMessage } from '../api';
import type { ApiCall } from '../screens/Shell';

function trim(value: string | null): string {
  if (!value) return '';
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

const PURPOSE_LABELS: Record<TaxCode['purpose'], string> = { purchase: 'Purchasing', sales: 'Sales', both: 'Sales and Purchasing' };

export function TaxCodesForm({ call, canAdminister, onClose }: { call: ApiCall; canAdminister: boolean; onClose: () => void }) {
  const [codes, setCodes] = useState<TaxCode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState<TaxCode['purpose']>('purchase');
  const [rate, setRate] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [newRate, setNewRate] = useState('');
  const [newRateFrom, setNewRateFrom] = useState('');

  const load = useCallback(async () => {
    const result = await call<TaxCode[]>('GET', '/v1/fin/tax-codes');
    if (result.ok) setCodes(result.body);
    else setError(errorMessage(result));
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = codes.find((row) => row.id === selectedId) ?? null;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const result = await call<TaxCode>('POST', '/v1/fin/tax-codes', { code, name, purpose, rate, validFrom });
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setNotice(`Tax code ${result.body.code} added.`);
    setCode('');
    setName('');
    setRate('');
    await load();
    setSelectedId(result.body.id);
  };

  const addRate = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setError(null);
    const result = await call<TaxCode>('POST', `/v1/fin/tax-codes/${selected.id}/rates`, { rate: newRate, validFrom: newRateFrom });
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setNotice(`New rate for ${selected.code} from ${newRateFrom}.`);
    setNewRate('');
    setNewRateFrom('');
    await load();
  };

  return (
    <FormWindow title="Tax Codes - Setup" onClose={onClose} footerLeft={<Button type="button" variant="primary" onClick={onClose}>OK</Button>}>
      {error ? <Banner>{error}</Banner> : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}
      <Banner tone="warning">
        Tax codes and rates must be set up by your accountant for your jurisdiction. The system does not supply statutory rates and does not certify tax compliance.
      </Banner>
      <div className="ui-table-wrap">
        <table className="ui-table company-grid">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Used For</th>
              <th className="numeric">Current Rate %</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {codes.map((row) => (
              <tr key={row.id} aria-selected={row.id === selectedId} onClick={() => setSelectedId(row.id)}>
                <td>{row.code}</td>
                <td>{row.name}</td>
                <td>{PURPOSE_LABELS[row.purpose]}</td>
                <td className="numeric">{trim(row.currentRate) || 'not yet valid'}</td>
                <td>
                  <StatusBadge status={row.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected ? (
        <>
          <div className="form-section">Rate History for {selected.code}</div>
          <DataTable
            rows={selected.rates}
            rowKey={(row) => row.validFrom}
            empty="No rates."
            columns={[
              { key: 'from', header: 'Valid From', render: (row) => row.validFrom },
              { key: 'rate', header: 'Rate %', render: (row) => trim(row.rate) },
            ]}
          />
          {canAdminister ? (
            <form onSubmit={addRate} className="inline-fields" noValidate>
              <label className="ui-field">
                <span>New Rate %</span>
                <input className="grid-input grid-input--number" inputMode="decimal" value={newRate} onChange={(e) => setNewRate(e.target.value)} />
              </label>
              <label className="ui-field">
                <span>Valid From</span>
                <input className="grid-input" type="date" value={newRateFrom} onChange={(e) => setNewRateFrom(e.target.value)} />
              </label>
              <Button type="submit" disabled={!newRate || !newRateFrom}>
                Add Rate
              </Button>
            </form>
          ) : null}
          <p className="ui-muted">Rates are versioned: posted documents keep the rate that applied on their posting date.</p>
        </>
      ) : null}
      {canAdminister ? (
        <form onSubmit={create} noValidate>
          <div className="form-section">New Tax Code</div>
          <div className="form-columns">
            <div>
              <label className="ui-field">
                <span>Code</span>
                <input className="grid-input" value={code} maxLength={20} onChange={(e) => setCode(e.target.value)} />
              </label>
              <label className="ui-field">
                <span>Name</span>
                <input className="grid-input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="ui-field">
                <span>Used For</span>
                <select className="grid-input" value={purpose} onChange={(e) => setPurpose(e.target.value as TaxCode['purpose'])}>
                  <option value="purchase">Purchasing</option>
                  <option value="sales">Sales</option>
                  <option value="both">Sales and Purchasing</option>
                </select>
              </label>
            </div>
            <div>
              <label className="ui-field">
                <span>Rate %</span>
                <input className="grid-input grid-input--number" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
              </label>
              <label className="ui-field">
                <span>Valid From</span>
                <input className="grid-input" type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
              </label>
              <Button type="submit" variant="primary" disabled={!code || !name || !rate || !validFrom}>
                Add
              </Button>
            </div>
          </div>
        </form>
      ) : null}
    </FormWindow>
  );
}

export function DocumentSettingsForm({
  call,
  canAdminister,
  canViewSales,
  canAdministerSales,
  onClose,
}: {
  call: ApiCall;
  canAdminister: boolean;
  canViewSales: boolean;
  canAdministerSales: boolean;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<PurchasingSettings | null>(null);
  const [tolerance, setTolerance] = useState('');
  const [salesSettings, setSalesSettings] = useState<SalesSettings | null>(null);
  const [salesTolerance, setSalesTolerance] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void call<PurchasingSettings>('GET', '/v1/pur/settings').then((result) => {
      if (result.ok) {
        setSettings(result.body);
        setTolerance(trim(result.body.priceTolerancePercent));
      } else {
        setError(errorMessage(result));
      }
    });
    if (canViewSales) {
      void call<SalesSettings>('GET', '/v1/sal/settings').then((result) => {
        if (result.ok) {
          setSalesSettings(result.body);
          setSalesTolerance(result.body.priceTolerancePercent === null ? '' : trim(result.body.priceTolerancePercent));
        } else {
          setError(errorMessage(result));
        }
      });
    }
  }, [call, canViewSales]);

  const purchasingDirty = settings !== null && tolerance !== trim(settings.priceTolerancePercent);
  const salesDirty = salesSettings !== null && salesTolerance.trim() !== (salesSettings.priceTolerancePercent === null ? '' : trim(salesSettings.priceTolerancePercent));
  const dirty = purchasingDirty || salesDirty;

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    if (purchasingDirty && settings) {
      const result = await call<PurchasingSettings>('PUT', '/v1/pur/settings', { priceTolerancePercent: tolerance || '0', version: settings.version });
      if (!result.ok) {
        setBusy(false);
        setError(errorMessage(result));
        return;
      }
      setSettings(result.body);
    }
    if (salesDirty && salesSettings) {
      const result = await call<SalesSettings>('PUT', '/v1/sal/settings', { priceTolerancePercent: salesTolerance.trim() || null, version: salesSettings.version });
      if (!result.ok) {
        setBusy(false);
        setError(errorMessage(result));
        return;
      }
      setSalesSettings(result.body);
      setSalesTolerance(result.body.priceTolerancePercent === null ? '' : trim(result.body.priceTolerancePercent));
    }
    setBusy(false);
    setNotice('Operation completed successfully.');
  };

  return (
    <FormWindow
      title="Document Settings"
      onClose={onClose}
      width={620}
      footerLeft={
        <>
          <Button type="button" variant="primary" busy={busy} onClick={() => (dirty ? void save() : onClose())}>
            {dirty ? 'Update' : 'OK'}
          </Button>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      {error ? <Banner>{error}</Banner> : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}
      <div className="form-section">Purchasing</div>
      <label className="ui-field">
        <span>Price tolerance %</span>
        <input
          className="grid-input grid-input--number"
          inputMode="decimal"
          value={tolerance}
          readOnly={!canAdminister}
          onChange={(e) => setTolerance(e.target.value)}
        />
      </label>
      <p className="ui-muted">
        An A/P invoice price may differ from its goods receipt price by up to this percentage. Larger differences need a user with the price override permission; each override is audited.
      </p>
      {salesSettings ? (
        <>
          <div className="form-section">Sales</div>
          <label className="ui-field">
            <span>Price tolerance %</span>
            <input
              className="grid-input grid-input--number"
              inputMode="decimal"
              aria-label="Sales price tolerance %"
              placeholder="No check"
              value={salesTolerance}
              readOnly={!canAdministerSales}
              onChange={(e) => setSalesTolerance(e.target.value)}
            />
          </label>
          <p className="ui-muted">
            Leave blank to allow A/R invoice prices to be changed freely, as in the default Business One-style setup. When set, an A/R invoice price may differ from its sales order or delivery price by up to this percentage; larger differences need a user with the sales price override permission and each override is audited.
          </p>
        </>
      ) : null}
    </FormWindow>
  );
}
