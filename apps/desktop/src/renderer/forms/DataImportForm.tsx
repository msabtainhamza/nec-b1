import { useState } from 'react';
import { MASTER_IMPORT_COLUMNS, MASTER_IMPORT_MAX_ROWS, MASTER_IMPORT_TEMPLATES, MIGRATION_ORDER, type MasterImportKind, type MasterImportResult } from '@nec/contracts';
import { Banner, Button, FormWindow } from '@nec/ui';
import { errorMessage } from '../api';
import type { ApiCall } from '../screens/Shell';
import { BYTE_ORDER_MARK } from './ReportForms';

const MAX_FILE_BYTES = 2_000_000;

const KINDS: { kind: MasterImportKind; label: string; path: string; updatable: boolean }[] = [
  { kind: 'partner', label: 'Business Partners', path: '/v1/bp/partners/import', updatable: true },
  { kind: 'item', label: 'Items', path: '/v1/inv/items/import', updatable: true },
  { kind: 'price', label: 'Prices', path: '/v1/inv/price-lists/import', updatable: false },
];

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read'));
    reader.readAsText(file, 'utf-8');
  });
}

export function DataImportForm({ call, allowed, onClose }: { call: ApiCall; allowed: Record<MasterImportKind, boolean>; onClose: () => void }) {
  const available = KINDS.filter((entry) => allowed[entry.kind]);
  const [kind, setKind] = useState<MasterImportKind>(available[0]?.kind ?? 'partner');
  const [updateExisting, setUpdateExisting] = useState(false);
  const [fileName, setFileName] = useState('');
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<MasterImportResult | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const config = KINDS.find((entry) => entry.kind === kind) ?? KINDS[0]!;

  const invalidate = () => {
    setResult(null);
    setNotice(null);
    setIdempotencyKey(crypto.randomUUID());
  };

  const downloadTemplate = async () => {
    const template = MASTER_IMPORT_TEMPLATES[kind];
    const saved = await window.erp.saveTextFile(template.fileName, `${BYTE_ORDER_MARK}${template.content}`);
    if (saved.saved) setNotice('Template saved.');
  };

  const chooseFile = async (file: File | undefined) => {
    invalidate();
    setError(null);
    setCsv('');
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError('The file is larger than 2 MB. Split it into several imports.');
      return;
    }
    try {
      setCsv(await readFile(file));
      setFileName(file.name);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The file could not be read');
    }
  };

  const send = async (mode: 'validate' | 'commit') => {
    if (busy) return;
    setError(null);
    setNotice(null);
    if (!csv) {
      setError('Choose a file to import.');
      return;
    }
    if (mode === 'commit' && !window.confirm(`Import ${result?.rowCount ?? 0} rows from ${fileName}?`)) return;
    setBusy(true);
    const response = await call<MasterImportResult>('POST', config.path, { idempotencyKey, mode, csv, fileName, updateExisting: config.updatable && updateExisting });
    setBusy(false);
    if (!response.ok) {
      setError(response.status === 0 ? `${errorMessage(response)} Choosing Import again safely retries the same file.` : errorMessage(response));
      return;
    }
    setResult(response.body);
    if (response.body.committed) {
      setNotice(`Imported ${response.body.rowCount} rows: ${response.body.created} added, ${response.body.updated} updated.`);
      setIdempotencyKey(crypto.randomUUID());
    }
  };

  const validated = result !== null && result.mode === 'validate' && result.valid;

  return (
    <FormWindow
      title="Data Import"
      width={860}
      onClose={onClose}
      footerLeft={
        <Button type="button" variant="primary" onClick={onClose}>
          OK
        </Button>
      }
    >
      {error ? <Banner>{error}</Banner> : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}
      <div className="inline-fields">
        <label className="ui-field">
          <span>Import</span>
          <select
            className="grid-input"
            aria-label="Import type"
            value={kind}
            onChange={(e) => {
              invalidate();
              setKind(e.target.value as MasterImportKind);
            }}
          >
            {available.map((entry) => (
              <option key={entry.kind} value={entry.kind}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        {config.updatable ? (
          <label className="flag-row">
            <input
              type="checkbox"
              checked={updateExisting}
              onChange={(e) => {
                invalidate();
                setUpdateExisting(e.target.checked);
              }}
            />{' '}
            Update existing records
          </label>
        ) : null}
        <Button type="button" onClick={() => void downloadTemplate()}>
          Download Template
        </Button>
        <label className="ui-field">
          <span>File</span>
          <input className="grid-input" type="file" accept=".csv,text/csv" aria-label="Import file" onChange={(e) => void chooseFile(e.target.files?.[0])} />
        </label>
        <Button type="button" busy={busy && !validated} onClick={() => void send('validate')}>
          Validate
        </Button>
        <Button type="button" variant="primary" busy={busy && validated} disabled={!validated} onClick={() => void send('commit')}>
          Import
        </Button>
      </div>
      <p className="ui-muted">
        CSV columns: {MASTER_IMPORT_COLUMNS[kind].map((column) => `${column.name}${column.required ? ' (required)' : ''}`).join(', ')}. Up to {MASTER_IMPORT_MAX_ROWS} rows. Codes are matched to this company's
        master data without regard to case.{' '}
        {kind === 'price'
          ? 'A blank price removes the item from the price list.'
          : 'New records need a name and type. With Update existing records, rows whose code already exists change only the columns that are filled in.'}{' '}
        Validate checks every row with the same rules as manual entry without saving anything; Import saves all rows or none.
      </p>
      {result && !result.committed ? (
        result.valid ? (
          <p className="ui-muted">
            {result.rowCount} rows are valid: {result.created} to add, {result.updated} to update. Choose Import to save them.
          </p>
        ) : (
          <div className="ui-table-wrap">
            <table className="ui-table" aria-label="Import errors">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Column</th>
                  <th>Problem</th>
                </tr>
              </thead>
              <tbody>
                {result.errors.map((row, index) => (
                  <tr key={`${row.row ?? 'file'}-${row.column ?? ''}-${index}`}>
                    <td>{row.row ?? 'File'}</td>
                    <td>{row.column ?? ''}</td>
                    <td>{row.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
      <div className="form-section">Recommended Migration Order</div>
      <ol className="related-list">
        {MIGRATION_ORDER.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </FormWindow>
  );
}
