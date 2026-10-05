import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type {
  Account,
  AdjustmentPreview,
  InventoryAdjustment,
  InventoryDocumentDirection,
  ItemStock,
  ItemSummary,
  Page,
  StockDocumentHeader,
  StockDocumentSummary,
  StockTransfer,
  Warehouse,
} from '@nec/contracts';
import { Banner, Button, FormWindow, LinkArrow, StatusBadge } from '@nec/ui';
import { errorMessage } from '../api';
import { formatAmount, today } from '../format';
import type { ApiCall } from '../screens/Shell';
import { useRecordToolbar } from '../toolbar';
import { OpeningImportPanel } from './OpeningImportPanel';

interface LineDraft {
  key: string;
  itemId: string;
  warehouseId: string;
  quantity: string;
  unitCost: string;
  inStock: string | null;
}

const LABELS: Record<InventoryDocumentDirection, string> = { receipt: 'Goods Receipt', issue: 'Goods Issue', opening: 'Inventory Opening Balance' };

let keySeed = 0;
const emptyLine = (warehouseId = ''): LineDraft => ({ key: `it-${++keySeed}`, itemId: '', warehouseId, quantity: '', unitCost: '', inStock: null });
const clean = (value: string) => value.replace(/,/g, '').trim();

function trim(value: string | null): string {
  if (!value) return '';
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

function ReadField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="ui-field">
      <span>{label}</span>
      <span className="form-value">{value}</span>
    </div>
  );
}

function useMasterData(call: ApiCall) {
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  useEffect(() => {
    void Promise.all([
      call<Page<ItemSummary>>('GET', '/v1/inv/items?itemType=inventory&status=active&limit=200'),
      call<Warehouse[]>('GET', '/v1/inv/warehouses'),
      call<Account[]>('GET', '/v1/fin/accounts'),
    ]).then(([i, w, a]) => {
      if (i.ok) setItems(i.body.items.filter((row) => row.itemType === 'inventory'));
      if (w.ok) setWarehouses(w.body.filter((row) => row.status === 'active'));
      if (a.ok) setAccounts(a.body.filter((row) => !row.isTitle && row.status === 'active' && !row.controlKind));
    });
  }, [call]);
  return { items, warehouses, accounts };
}

function DocumentStatus({ document, onOpen }: { document: StockDocumentHeader; onOpen: (id: string) => void }) {
  return (
    <>
      {document.cancellationReason ? <p className="ui-muted">Cancellation reason: {document.cancellationReason}</p> : null}
      {document.cancelledById || document.cancellationOfId ? (
        <p className="pager">
          <LinkArrow label="Open linked document" onClick={() => onOpen(document.cancelledById ?? document.cancellationOfId ?? '')} />
          {document.cancelledById ? 'Cancelled by a cancellation document' : 'Cancels the original document'}
        </p>
      ) : null}
    </>
  );
}

function CancelPanel({ label, busy, onPost, note }: { label: string; busy: boolean; onPost: (date: string, reason: string) => void; note: string }) {
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('');
  return (
    <div className="reverse-panel">
      <div className="form-section">Cancel {label}</div>
      <div className="inline-fields">
        <label className="ui-field">
          <span>Cancellation Date</span>
          <input className="grid-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="ui-field">
          <span>Reason</span>
          <input className="grid-input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </label>
        <Button type="button" variant="primary" busy={busy} onClick={() => onPost(date, reason.trim())}>
          Post Cancellation
        </Button>
      </div>
      <p className="ui-muted">{note}</p>
    </div>
  );
}

function ChooserWindow({ title, rows, onPick, onClose }: { title: string; rows: StockDocumentSummary[]; onPick: (id: string) => void; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <FormWindow
        title={title}
        width={760}
        onClose={onClose}
        footerLeft={
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
        }
      >
        {rows.length === 0 ? (
          <p className="ui-muted">No documents yet.</p>
        ) : (
          <div className="ui-table-wrap">
            <table className="ui-table company-grid">
              <thead>
                <tr>
                  <th>No.</th>
                  <th>Posting Date</th>
                  <th>Details</th>
                  <th>Reason</th>
                  <th className="numeric">Value</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} onDoubleClick={() => onPick(row.id)}>
                    <td>
                      <LinkArrow label={`Open ${row.documentNumber}`} onClick={() => onPick(row.id)} />
                      {row.documentNumber}
                    </td>
                    <td>{row.postingDate}</td>
                    <td>{row.description}</td>
                    <td>{row.reason}</td>
                    <td className="numeric">{formatAmount(row.totalValue)}</td>
                    <td>{row.isCancellation ? 'cancellation' : row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FormWindow>
    </div>
  );
}

export function InventoryAdjustmentForm({
  call,
  direction,
  canPost,
  canCancel,
  currency,
  onClose,
}: {
  call: ApiCall;
  direction: InventoryDocumentDirection;
  canPost: boolean;
  canCancel: boolean;
  currency: string;
  onClose: () => void;
}) {
  const label = LABELS[direction];
  const opening = direction === 'opening';
  const withCost = direction !== 'issue';
  const basePath = opening ? '/v1/inv/opening-balances' : '/v1/inv/adjustments';
  const { items, warehouses, accounts } = useMasterData(call);
  const [mode, setMode] = useState<'add' | 'view'>(canPost ? 'add' : 'view');
  const [document, setDocument] = useState<InventoryAdjustment | null>(null);
  const [postingDate, setPostingDate] = useState(today());
  const [reason, setReason] = useState('');
  const [remarks, setRemarks] = useState('');
  const [offsetAccountId, setOffsetAccountId] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [preview, setPreview] = useState<AdjustmentPreview | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [choices, setChoices] = useState<StockDocumentSummary[] | null>(null);
  const [importing, setImporting] = useState(false);

  const defaultWarehouse = warehouses.find((row) => row.isBranchDefault)?.id ?? warehouses[0]?.id ?? '';
  useEffect(() => {
    if (defaultWarehouse) setLines((current) => current.map((line) => (line.warehouseId ? line : { ...line, warehouseId: defaultWarehouse })));
  }, [defaultWarehouse]);

  const load = useCallback(
    async (id: string) => {
      const result = await call<InventoryAdjustment>('GET', `${basePath}/${id}`);
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      setDocument(result.body);
      setMode('view');
      setCancelling(false);
      setImporting(false);
    },
    [call, basePath],
  );

  const filled = lines.filter((line) => line.itemId);
  const dirty = mode === 'add' && filled.length > 0;

  const reset = () => {
    setDocument(null);
    setMode('add');
    setReason('');
    setRemarks('');
    setLines([emptyLine(defaultWarehouse)]);
    setPreview(null);
    setError(null);
    setNotice(null);
    setIdempotencyKey(crypto.randomUUID());
  };

  useRecordToolbar({
    find: () =>
      void call<Page<StockDocumentSummary>>('GET', opening ? `${basePath}?limit=200` : `${basePath}?direction=${direction}&limit=200`).then((result) => {
        if (result.ok) setChoices(result.body.items);
        else setError(errorMessage(result));
      }),
    add: canPost
      ? () => {
          if (dirty && !window.confirm(`Discard this ${label.toLowerCase()}?`)) return;
          reset();
        }
      : undefined,
  });

  const setLine = async (key: string, patch: Partial<LineDraft>) => {
    setPreview(null);
    const next = { ...(lines.find((line) => line.key === key) as LineDraft), ...patch };
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
    if ((patch.itemId || patch.warehouseId) && next.itemId && next.warehouseId) {
      const result = await call<ItemStock>('GET', `/v1/inv/items/${next.itemId}/stock`);
      const onHand = result.ok ? (result.body.warehouses.find((row) => row.warehouseId === next.warehouseId)?.onHand ?? '0') : null;
      setLines((current) => current.map((line) => (line.key === key ? { ...line, inStock: onHand } : line)));
    }
  };

  const body = () => ({
    idempotencyKey,
    ...(opening ? {} : { direction }),
    postingDate,
    offsetAccountId: offsetAccountId || undefined,
    reason: reason.trim(),
    remarks,
    lines: filled.map((line) => ({
      itemId: line.itemId,
      warehouseId: line.warehouseId,
      quantity: clean(line.quantity),
      ...(withCost && (opening || clean(line.unitCost)) ? { unitCost: clean(line.unitCost) } : {}),
    })),
  });

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    if (mode === 'view') {
      onClose();
      return;
    }
    setError(null);
    if (filled.length === 0 || !reason.trim()) {
      setError('Enter a reason and at least one item line.');
      return;
    }
    setBusy(true);
    if (!preview) {
      const result = await call<AdjustmentPreview>('POST', `${basePath}/preview`, body());
      setBusy(false);
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      setPreview(result.body);
      return;
    }
    const result = await call<InventoryAdjustment>('POST', basePath, body());
    setBusy(false);
    if (!result.ok) {
      setPreview(null);
      setError(result.status === 0 ? `${errorMessage(result)} Posting again safely retries the same document.` : errorMessage(result));
      return;
    }
    setNotice(`${label} ${result.body.documentNumber} posted${result.body.journalNumber ? ` with journal entry ${result.body.journalNumber}` : ''}.`);
    setDocument(result.body);
    setPreview(null);
    setMode('view');
    setIdempotencyKey(crypto.randomUUID());
  };

  const cancelDocument = async (date: string, cancelReason: string) => {
    if (!document || busy) return;
    if (!cancelReason) {
      setError('Enter a reason for the cancellation.');
      return;
    }
    if (!window.confirm(`Cancel ${label.toLowerCase()} ${document.documentNumber}? Its stock movements and journal will be reversed.`)) return;
    setBusy(true);
    setError(null);
    const result = await call<InventoryAdjustment>('POST', `${basePath}/${document.id}/cancel`, { idempotencyKey: crypto.randomUUID(), postingDate: date, reason: cancelReason });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setNotice(`Cancellation ${result.body.documentNumber} posted.`);
    await load(document.id);
  };

  const closeForm = () => {
    if (dirty && !window.confirm(`Discard this ${label.toLowerCase()}?`)) return;
    onClose();
  };

  return (
    <form onSubmit={submit} noValidate>
      <FormWindow
        title={mode === 'view' && document ? `${label} ${document.documentNumber}${document.isCancellation ? ' (Cancellation)' : ''}` : `${label} - Add`}
        onClose={closeForm}
        footerLeft={
          <>
            <Button type="submit" variant="primary" busy={busy && !cancelling}>
              {mode === 'add' ? (preview ? 'Post' : 'Add') : 'OK'}
            </Button>
            <Button type="button" onClick={preview ? () => setPreview(null) : closeForm}>
              {preview ? 'Back' : 'Cancel'}
            </Button>
          </>
        }
        footerRight={
          mode === 'view' && document && canCancel && !document.isCancellation && document.status === 'posted' ? (
            <Button type="button" onClick={() => setCancelling((value) => !value)}>
              Cancel Document
            </Button>
          ) : mode === 'add' && opening && canPost ? (
            <Button type="button" onClick={() => setImporting((value) => !value)}>
              Import from File
            </Button>
          ) : null
        }
      >
        {error ? <Banner>{error}</Banner> : null}
        {notice ? <Banner tone="info">{notice}</Banner> : null}
        {mode === 'view' && document ? (
          <>
            <div className="form-columns">
              <div>
                <ReadField label="Reason" value={document.reason} />
                <ReadField label="Offset Account" value={`${document.offsetAccountCode} - ${document.offsetAccountName}`} />
                <ReadField label="Remarks" value={document.remarks ?? ''} />
                <ReadField label="Journal Entry" value={document.journalNumber ?? 'None'} />
              </div>
              <div>
                <ReadField label="No." value={document.documentNumber} />
                <ReadField label="Status" value={<StatusBadge status={document.status === 'posted' ? 'active' : 'cancelled'} />} />
                <ReadField label="Posting Date" value={document.postingDate} />
              </div>
            </div>
            <DocumentStatus document={document} onOpen={(id) => void load(id)} />
            <div className="ui-table-wrap journal-grid">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th className="ui-table__row-number">#</th>
                    <th>Item No.</th>
                    <th>Description</th>
                    <th>Whse</th>
                    <th>Inventory Account</th>
                    <th className="numeric">Quantity</th>
                    <th className="numeric">Unit Cost</th>
                    <th className="numeric">Value ({currency})</th>
                  </tr>
                </thead>
                <tbody>
                  {document.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="ui-table__row-number">{line.lineNo}</td>
                      <td>{line.itemCode}</td>
                      <td>{line.itemName}</td>
                      <td>{line.warehouseCode}</td>
                      <td>{line.inventoryAccountCode}</td>
                      <td className="numeric">
                        {trim(line.quantity)} {line.uomCode}
                      </td>
                      <td className="numeric">{formatAmount(line.unitCost)}</td>
                      <td className="numeric">{formatAmount(line.value)}</td>
                    </tr>
                  ))}
                  <tr className="totals-row">
                    <td colSpan={7}>Total</td>
                    <td className="numeric">{formatAmount(document.totalValue)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        ) : mode === 'add' ? (
          <>
            <div className="form-columns">
              <div>
                <label className="ui-field">
                  <span>Reason</span>
                  <input className="grid-input" value={reason} maxLength={500} onChange={(e) => {
                    setPreview(null);
                    setReason(e.target.value);
                  }} />
                </label>
                <label className="ui-field">
                  <span>Offset Account</span>
                  <select className="grid-input" value={offsetAccountId} onChange={(e) => {
                    setPreview(null);
                    setOffsetAccountId(e.target.value);
                  }}>
                    <option value="">{opening ? 'Opening balance offset (default)' : 'Inventory adjustment (default)'}</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} - {account.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="ui-field">
                  <span>Remarks</span>
                  <input className="grid-input" value={remarks} maxLength={500} onChange={(e) => {
                    setPreview(null);
                    setRemarks(e.target.value);
                  }} />
                </label>
              </div>
              <div>
                <label className="ui-field">
                  <span>Posting Date</span>
                  <input className="grid-input" type="date" value={postingDate} onChange={(e) => {
                    setPreview(null);
                    setPostingDate(e.target.value);
                  }} />
                </label>
              </div>
            </div>
            <div className="ui-table-wrap">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th className="ui-table__row-number">#</th>
                    <th>Item No.</th>
                    <th>Whse</th>
                    <th className="numeric">In Stock</th>
                    <th className="numeric">Quantity</th>
                    {withCost ? <th className="numeric">Unit Cost</th> : null}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => (
                    <tr key={line.key}>
                      <td className="ui-table__row-number">{index + 1}</td>
                      <td>
                        <select className="grid-input" aria-label={`Line ${index + 1} item`} value={line.itemId} onChange={(e) => void setLine(line.key, { itemId: e.target.value })}>
                          <option value="" />
                          {items.map((row) => (
                            <option key={row.id} value={row.id}>
                              {row.code} - {row.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select className="grid-input" aria-label={`Line ${index + 1} warehouse`} value={line.warehouseId} onChange={(e) => void setLine(line.key, { warehouseId: e.target.value })}>
                          {warehouses.map((warehouse) => (
                            <option key={warehouse.id} value={warehouse.id}>
                              {warehouse.code}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="numeric">{line.inStock === null ? '' : trim(line.inStock)}</td>
                      <td>
                        <input className="grid-input grid-input--number" inputMode="decimal" aria-label={`Line ${index + 1} quantity`} value={line.quantity} onChange={(e) => void setLine(line.key, { quantity: e.target.value })} />
                      </td>
                      {withCost ? (
                        <td>
                          <input
                            className="grid-input grid-input--number"
                            inputMode="decimal"
                            placeholder={opening ? '' : 'Average'}
                            aria-label={`Line ${index + 1} unit cost`}
                            value={line.unitCost}
                            onChange={(e) => void setLine(line.key, { unitCost: e.target.value })}
                          />
                        </td>
                      ) : null}
                      <td>
                        {lines.length > 1 ? (
                          <Button type="button" variant="ghost" aria-label={`Remove line ${index + 1}`} onClick={() => {
                            setPreview(null);
                            setLines((current) => current.filter((row) => row.key !== line.key));
                          }}>
                            ×
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="pager">
              <Button type="button" onClick={() => {
                setPreview(null);
                setLines((current) => [...current, emptyLine(defaultWarehouse)]);
              }}>
                Add Line
              </Button>
              <span className="ui-muted">
                {opening
                  ? 'Enter the counted quantity and unit cost for each item and warehouse. Items that already have stock transactions in a warehouse use Goods Receipt or Goods Issue instead.'
                  : direction === 'receipt'
                    ? 'Leave the unit cost empty to use the current average cost.'
                    : 'Issued stock is valued at the current moving average cost.'}
              </span>
            </p>
            {preview ? (
              <div className="reverse-panel">
                <div className="form-section">Valuation Impact (not yet posted)</div>
                <div className="ui-table-wrap">
                  <table className="ui-table" aria-label="Valuation impact">
                    <thead>
                      <tr>
                        <th>Item No.</th>
                        <th className="numeric">On Hand Before</th>
                        <th className="numeric">On Hand After</th>
                        <th className="numeric">Value Before</th>
                        <th className="numeric">Value After</th>
                        <th className="numeric">Average Cost After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.valuations.map((row) => (
                        <tr key={row.itemCode}>
                          <td>{row.itemCode}</td>
                          <td className="numeric">{trim(row.onHandBefore)}</td>
                          <td className="numeric">{trim(row.onHandAfter)}</td>
                          <td className="numeric">{formatAmount(row.valueBefore)}</td>
                          <td className="numeric">{formatAmount(row.valueAfter)}</td>
                          <td className="numeric">{formatAmount(row.averageCostAfter)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {preview.journalLines.length > 0 ? (
                  <div className="ui-table-wrap">
                    <table className="ui-table" aria-label="Journal preview">
                      <thead>
                        <tr>
                          <th>G/L Account</th>
                          <th className="numeric">Debit</th>
                          <th className="numeric">Credit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.journalLines.map((row) => (
                          <tr key={row.accountCode}>
                            <td>
                              {row.accountCode} - {row.accountName}
                            </td>
                            <td className="numeric">{row.debit === '0.0000' ? '' : formatAmount(row.debit)}</td>
                            <td className="numeric">{row.credit === '0.0000' ? '' : formatAmount(row.credit)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="ui-muted">No journal entry: the total value is zero.</p>
                )}
                <p className="ui-muted">Choose Post to confirm. The server checks stock and valuation again when posting.</p>
              </div>
            ) : null}
          </>
        ) : (
          <p className="ui-muted">Use Find to open a {label.toLowerCase()}.</p>
        )}
        {importing && mode === 'add' ? (
          <OpeningImportPanel
            call={call}
            kind="inventory"
            currency={currency}
            onCommitted={(id, number) => {
              void load(id).then(() => setNotice(`${label} ${number} imported.`));
            }}
          />
        ) : null}
        {cancelling && document ? (
          <CancelPanel
            label={label}
            busy={busy}
            onPost={(date, cancelReason) => void cancelDocument(date, cancelReason)}
            note="Reverses the stock movements and journal. Blocked when later stock transactions would require recosting."
          />
        ) : null}
      </FormWindow>
      {choices ? (
        <ChooserWindow
          title={`List of ${label}s`}
          rows={choices}
          onClose={() => setChoices(null)}
          onPick={(id) => {
            setChoices(null);
            void load(id);
          }}
        />
      ) : null}
    </form>
  );
}

export function InventoryTransferForm({ call, canPost, canCancel, currency, onClose }: { call: ApiCall; canPost: boolean; canCancel: boolean; currency: string; onClose: () => void }) {
  const { items, warehouses } = useMasterData(call);
  const [mode, setMode] = useState<'add' | 'view'>(canPost ? 'add' : 'view');
  const [document, setDocument] = useState<StockTransfer | null>(null);
  const [fromWarehouseId, setFromWarehouseId] = useState('');
  const [toWarehouseId, setToWarehouseId] = useState('');
  const [postingDate, setPostingDate] = useState(today());
  const [reason, setReason] = useState('');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [choices, setChoices] = useState<StockDocumentSummary[] | null>(null);

  const load = useCallback(
    async (id: string) => {
      const result = await call<StockTransfer>('GET', `/v1/inv/transfers/${id}`);
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      setDocument(result.body);
      setMode('view');
      setCancelling(false);
    },
    [call],
  );

  const stockIn = useCallback(
    async (itemId: string, warehouseId: string): Promise<string | null> => {
      if (!itemId || !warehouseId) return null;
      const result = await call<ItemStock>('GET', `/v1/inv/items/${itemId}/stock`);
      return result.ok ? (result.body.warehouses.find((row) => row.warehouseId === warehouseId)?.onHand ?? '0') : null;
    },
    [call],
  );

  useEffect(() => {
    void Promise.all(lines.map((line) => stockIn(line.itemId, fromWarehouseId))).then((values) =>
      setLines((current) => current.map((line, index) => ({ ...line, inStock: values[index] ?? null }))),
    );
  }, [fromWarehouseId, stockIn]);

  const filled = lines.filter((line) => line.itemId);
  const dirty = mode === 'add' && filled.length > 0;

  const reset = () => {
    setDocument(null);
    setMode('add');
    setReason('');
    setRemarks('');
    setLines([emptyLine()]);
    setError(null);
    setNotice(null);
    setIdempotencyKey(crypto.randomUUID());
  };

  useRecordToolbar({
    find: () =>
      void call<Page<StockDocumentSummary>>('GET', '/v1/inv/transfers?limit=200').then((result) => {
        if (result.ok) setChoices(result.body.items);
        else setError(errorMessage(result));
      }),
    add: canPost
      ? () => {
          if (dirty && !window.confirm('Discard this inventory transfer?')) return;
          reset();
        }
      : undefined,
  });

  const setLine = async (key: string, patch: Partial<LineDraft>) => {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
    if (patch.itemId !== undefined) {
      const onHand = await stockIn(patch.itemId, fromWarehouseId);
      setLines((current) => current.map((line) => (line.key === key ? { ...line, inStock: onHand } : line)));
    }
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    if (mode === 'view') {
      onClose();
      return;
    }
    setError(null);
    if (!fromWarehouseId || !toWarehouseId || filled.length === 0 || !reason.trim()) {
      setError('Choose both warehouses, enter a reason and at least one item line.');
      return;
    }
    setBusy(true);
    const result = await call<StockTransfer>('POST', '/v1/inv/transfers', {
      idempotencyKey,
      fromWarehouseId,
      toWarehouseId,
      postingDate,
      reason: reason.trim(),
      remarks,
      lines: filled.map((line) => ({ itemId: line.itemId, quantity: clean(line.quantity) })),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.status === 0 ? `${errorMessage(result)} Choosing Add again safely retries the same transfer.` : errorMessage(result));
      return;
    }
    setNotice(`Inventory transfer ${result.body.documentNumber} posted${result.body.journalNumber ? ` with journal entry ${result.body.journalNumber}` : ''}.`);
    setDocument(result.body);
    setMode('view');
    setIdempotencyKey(crypto.randomUUID());
  };

  const cancelDocument = async (date: string, cancelReason: string) => {
    if (!document || busy) return;
    if (!cancelReason) {
      setError('Enter a reason for the cancellation.');
      return;
    }
    if (!window.confirm(`Cancel inventory transfer ${document.documentNumber}? Stock returns to ${document.fromWarehouseCode}.`)) return;
    setBusy(true);
    setError(null);
    const result = await call<StockTransfer>('POST', `/v1/inv/transfers/${document.id}/cancel`, { idempotencyKey: crypto.randomUUID(), postingDate: date, reason: cancelReason });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    setNotice(`Cancellation ${result.body.documentNumber} posted.`);
    await load(document.id);
  };

  const closeForm = () => {
    if (dirty && !window.confirm('Discard this inventory transfer?')) return;
    onClose();
  };

  const warehouseSelect = (value: string, onChange: (value: string) => void, aria: string) => (
    <select className="grid-input" aria-label={aria} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="" />
      {warehouses.map((warehouse) => (
        <option key={warehouse.id} value={warehouse.id}>
          {warehouse.code} - {warehouse.name}
        </option>
      ))}
    </select>
  );

  return (
    <form onSubmit={submit} noValidate>
      <FormWindow
        title={mode === 'view' && document ? `Inventory Transfer ${document.documentNumber}${document.isCancellation ? ' (Cancellation)' : ''}` : 'Inventory Transfer - Add'}
        onClose={closeForm}
        footerLeft={
          <>
            <Button type="submit" variant="primary" busy={busy && !cancelling}>
              {mode === 'add' ? 'Add' : 'OK'}
            </Button>
            <Button type="button" onClick={closeForm}>
              Cancel
            </Button>
          </>
        }
        footerRight={
          mode === 'view' && document && canCancel && !document.isCancellation && document.status === 'posted' ? (
            <Button type="button" onClick={() => setCancelling((value) => !value)}>
              Cancel Document
            </Button>
          ) : null
        }
      >
        {error ? <Banner>{error}</Banner> : null}
        {notice ? <Banner tone="info">{notice}</Banner> : null}
        {mode === 'view' && document ? (
          <>
            <div className="form-columns">
              <div>
                <ReadField label="From Warehouse" value={document.fromWarehouseCode} />
                <ReadField label="To Warehouse" value={document.toWarehouseCode} />
                <ReadField label="Reason" value={document.reason} />
                <ReadField label="Journal Entry" value={document.journalNumber ?? 'None (same inventory account)'} />
              </div>
              <div>
                <ReadField label="No." value={document.documentNumber} />
                <ReadField label="Status" value={<StatusBadge status={document.status === 'posted' ? 'active' : 'cancelled'} />} />
                <ReadField label="Posting Date" value={document.postingDate} />
                <ReadField label="Remarks" value={document.remarks ?? ''} />
              </div>
            </div>
            <DocumentStatus document={document} onOpen={(id) => void load(id)} />
            <div className="ui-table-wrap journal-grid">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th className="ui-table__row-number">#</th>
                    <th>Item No.</th>
                    <th>Description</th>
                    <th className="numeric">Quantity</th>
                    <th className="numeric">Value ({currency})</th>
                  </tr>
                </thead>
                <tbody>
                  {document.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="ui-table__row-number">{line.lineNo}</td>
                      <td>{line.itemCode}</td>
                      <td>{line.itemName}</td>
                      <td className="numeric">
                        {trim(line.quantity)} {line.uomCode}
                      </td>
                      <td className="numeric">{formatAmount(line.value)}</td>
                    </tr>
                  ))}
                  <tr className="totals-row">
                    <td colSpan={4}>Total</td>
                    <td className="numeric">{formatAmount(document.totalValue)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        ) : mode === 'add' ? (
          <>
            <div className="form-columns">
              <div>
                <label className="ui-field">
                  <span>From Warehouse</span>
                  {warehouseSelect(fromWarehouseId, setFromWarehouseId, 'From warehouse')}
                </label>
                <label className="ui-field">
                  <span>To Warehouse</span>
                  {warehouseSelect(toWarehouseId, setToWarehouseId, 'To warehouse')}
                </label>
                <label className="ui-field">
                  <span>Reason</span>
                  <input className="grid-input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
                </label>
              </div>
              <div>
                <label className="ui-field">
                  <span>Posting Date</span>
                  <input className="grid-input" type="date" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} />
                </label>
                <label className="ui-field">
                  <span>Remarks</span>
                  <input className="grid-input" value={remarks} maxLength={500} onChange={(e) => setRemarks(e.target.value)} />
                </label>
              </div>
            </div>
            <div className="ui-table-wrap">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th className="ui-table__row-number">#</th>
                    <th>Item No.</th>
                    <th className="numeric">In Stock (From)</th>
                    <th className="numeric">Quantity</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => (
                    <tr key={line.key}>
                      <td className="ui-table__row-number">{index + 1}</td>
                      <td>
                        <select className="grid-input" aria-label={`Line ${index + 1} item`} value={line.itemId} onChange={(e) => void setLine(line.key, { itemId: e.target.value })}>
                          <option value="" />
                          {items.map((row) => (
                            <option key={row.id} value={row.id}>
                              {row.code} - {row.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="numeric">{line.inStock === null ? '' : trim(line.inStock)}</td>
                      <td>
                        <input className="grid-input grid-input--number" inputMode="decimal" aria-label={`Line ${index + 1} quantity`} value={line.quantity} onChange={(e) => void setLine(line.key, { quantity: e.target.value })} />
                      </td>
                      <td>
                        {lines.length > 1 ? (
                          <Button type="button" variant="ghost" aria-label={`Remove line ${index + 1}`} onClick={() => setLines((current) => current.filter((row) => row.key !== line.key))}>
                            ×
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="pager">
              <Button type="button" onClick={() => setLines((current) => [...current, emptyLine()])}>
                Add Line
              </Button>
              <span className="ui-muted">Stock moves at the current average cost. A journal entry is posted only when the warehouses use different inventory accounts.</span>
            </p>
          </>
        ) : (
          <p className="ui-muted">Use Find to open an inventory transfer.</p>
        )}
        {cancelling && document ? (
          <CancelPanel
            label="Inventory Transfer"
            busy={busy}
            onPost={(date, cancelReason) => void cancelDocument(date, cancelReason)}
            note="Moves the stock back and reverses any journal. Blocked when later stock transactions would require recosting."
          />
        ) : null}
      </FormWindow>
      {choices ? (
        <ChooserWindow
          title="List of Inventory Transfers"
          rows={choices}
          onClose={() => setChoices(null)}
          onPick={(id) => {
            setChoices(null);
            void load(id);
          }}
        />
      ) : null}
    </form>
  );
}
