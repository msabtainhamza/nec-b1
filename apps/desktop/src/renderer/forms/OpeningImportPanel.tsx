import { useState } from 'react';
import { OPENING_IMPORT_COLUMNS, OPENING_IMPORT_MAX_ROWS, OPENING_IMPORT_TEMPLATES, type OpeningImportKind, type OpeningImportResult } from '@nec/contracts';
import { Banner, Button } from '@nec/ui';
import { errorMessage } from '../api';
import { formatAmount, today } from '../format';
import type { ApiCall } from '../screens/Shell';

const MAX_FILE_BYTES = 2_000_000;

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read'));
    reader.readAsText(file, 'utf-8');
  });
}

export function OpeningImportPanel({
  call,
  kind,
  currency,
  onCommitted,
}: {
  call: ApiCall;
  kind: OpeningImportKind;
  currency: string;
  onCommitted: (documentId: string, documentNumber: string) => void;
}) {
  const [fileName, setFileName] = useState('');
  const [csv, setCsv] = useState('');
  const [postingDate, setPostingDate] = useState(today());
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<OpeningImportResult | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const path = kind === 'inventory' ? '/v1/inv/opening-balances/import' : '/v1/fin/opening-balances/import';
  const template = OPENING_IMPORT_TEMPLATES[kind];

  const invalidate = () => {
    setResult(null);
    setNotice(null);
    setIdempotencyKey(crypto.randomUUID());
  };

  const downloadTemplate = async () => {
    const saved = await window.erp.saveTextFile(template.fileName, `\uFEFF${template.content}`);
    if (saved.saved) setNotice('Template saved.');
  };

  const chooseFile = async (file: File | undefined) => {
    invalidate();
    setError(null);
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
    if (!csv || !reason.trim()) {
      setError('Choose a file and enter a reason.');
      return;
    }
    if (mode === 'commit' && !window.confirm(`Post ${result?.rowCount ?? 0} rows from ${fileName} as one opening balance document?`)) return;
    setBusy(true);
    const response = await call<OpeningImportResult>('POST', path, {
      idempotencyKey,
      mode,
      csv,
      fileName,
      postingDate,
      reason: reason.trim(),
      ...(kind === 'inventory' ? {} : { kind }),
    });
    setBusy(false);
    if (!response.ok) {
      setError(response.status === 0 ? `${errorMessage(response)} Choosing Import again safely retries the same file.` : errorMessage(response));
      return;
    }
    setResult(response.body);
    if (response.body.committed && response.body.documentId && response.body.documentNumber) {
      setNotice(`Imported ${response.body.rowCount} rows as ${response.body.documentNumber}${response.body.journalNumber ? ` with journal entry ${response.body.journalNumber}` : ''}.`);
      setIdempotencyKey(crypto.randomUUID());
      onCommitted(response.body.documentId, response.body.documentNumber);
    }
  };

  const validated = result !== null && result.mode === 'validate' && result.valid;

  return (
    <div className="reverse-panel">
      <div className="form-section">Import from File</div>
      {error ? <Banner>{error}</Banner> : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}
      <p className="ui-muted">
        CSV columns: {OPENING_IMPORT_COLUMNS[kind].map((column) => `${column.name}${column.required ? ' (required)' : ''}`).join(', ')}. Up to {OPENING_IMPORT_MAX_ROWS} rows; dates as YYYY-MM-DD. Codes are matched to
        existing master data. Validate checks every row and the posting without saving anything.
      </p>
      <div className="inline-fields">
        <Button type="button" onClick={() => void downloadTemplate()}>
          Download Template
        </Button>
        <label className="ui-field">
          <span>File</span>
          <input className="grid-input" type="file" accept=".csv,text/csv" aria-label="Import file" onChange={(e) => void chooseFile(e.target.files?.[0])} />
        </label>
        <label className="ui-field">
          <span>Posting Date</span>
          <input className="grid-input" type="date" value={postingDate} onChange={(e) => {
            invalidate();
            setPostingDate(e.target.value);
          }} />
        </label>
        <label className="ui-field">
          <span>Reason</span>
          <input className="grid-input" aria-label="Import reason" value={reason} maxLength={500} onChange={(e) => {
            invalidate();
            setReason(e.target.value);
          }} />
        </label>
        <Button type="button" busy={busy && !validated} onClick={() => void send('validate')}>
          Validate
        </Button>
        <Button type="button" variant="primary" busy={busy && validated} disabled={!validated} onClick={() => void send('commit')}>
          Import
        </Button>
      </div>
      {result && !result.committed ? (
        result.valid ? (
          <p className="ui-muted">
            {result.rowCount} rows are valid. Debit {formatAmount(result.totalDebit)} {currency}, credit {formatAmount(result.totalCredit)} {currency}; the difference goes to the opening balance offset account. Choose Import to post.
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
    </div>
  );
}
