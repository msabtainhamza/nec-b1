import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { Item, ItemGroup, ItemSummary, ItemType, Page, PartnerSummary, PriceList, UnitOfMeasure, Warehouse } from '@nec/contracts';
import { Banner, Button, FormWindow, StatusBadge } from '@nec/ui';
import { errorMessage, fieldErrors } from '../api';
import type { ApiCall } from '../screens/Shell';
import { useRecordToolbar } from '../toolbar';
import { ItemStockPanel } from './StockForms';

type Mode = 'find' | 'add' | 'ok' | 'update';
type Tab = 'general' | 'prices' | 'inventory' | 'remarks';

const TYPE_LABELS: Record<ItemType, string> = { inventory: 'Inventory Item', non_inventory: 'Non-Inventory Item', service: 'Service' };

interface Draft {
  code: string;
  name: string;
  foreignName: string;
  itemType: ItemType;
  isSalesItem: boolean;
  isPurchaseItem: boolean;
  groupId: string;
  uomId: string;
  barcode: string;
  defaultWarehouseId: string;
  reorderPoint: string;
  preferredVendorId: string;
  status: 'active' | 'inactive';
  remarks: string;
  prices: Record<string, string>;
}

function emptyDraft(groups: ItemGroup[], units: UnitOfMeasure[], warehouses: Warehouse[]): Draft {
  return {
    code: '',
    name: '',
    foreignName: '',
    itemType: 'inventory',
    isSalesItem: true,
    isPurchaseItem: true,
    groupId: groups.find((group) => group.code === 'GENERAL')?.id ?? groups[0]?.id ?? '',
    uomId: units.find((unit) => unit.code === 'EA')?.id ?? units[0]?.id ?? '',
    barcode: '',
    defaultWarehouseId: warehouses.find((warehouse) => warehouse.status === 'active')?.id ?? '',
    reorderPoint: '',
    preferredVendorId: '',
    status: 'active',
    remarks: '',
    prices: {},
  };
}

function toDraft(item: Item): Draft {
  return {
    code: item.code,
    name: item.name,
    foreignName: item.foreignName ?? '',
    itemType: item.itemType,
    isSalesItem: item.isSalesItem,
    isPurchaseItem: item.isPurchaseItem,
    groupId: item.groupId,
    uomId: item.uomId,
    barcode: item.barcode ?? '',
    defaultWarehouseId: item.defaultWarehouseId ?? '',
    reorderPoint: item.reorderPoint ? item.reorderPoint.replace(/\.?0+$/, '') : '',
    preferredVendorId: item.preferredVendorId ?? '',
    status: item.status,
    remarks: item.remarks ?? '',
    prices: Object.fromEntries(item.prices.map((row) => [row.priceListId, row.price.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')])),
  };
}

export function ItemMasterDataForm({
  call,
  canCreate,
  canEdit,
  canViewStock,
  onClose,
}: {
  call: ApiCall;
  canCreate: boolean;
  canEdit: boolean;
  canViewStock: boolean;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>('find');
  const [tab, setTab] = useState<Tab>('general');
  const [groups, setGroups] = useState<ItemGroup[]>([]);
  const [units, setUnits] = useState<UnitOfMeasure[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [lists, setLists] = useState<PriceList[]>([]);
  const [vendors, setVendors] = useState<PartnerSummary[]>([]);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft([], [], []));
  const [record, setRecord] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<ItemSummary[] | null>(null);

  useEffect(() => {
    void Promise.all([
      call<ItemGroup[]>('GET', '/v1/inv/item-groups'),
      call<UnitOfMeasure[]>('GET', '/v1/inv/units'),
      call<Warehouse[]>('GET', '/v1/inv/warehouses'),
      call<PriceList[]>('GET', '/v1/inv/price-lists'),
      call<Page<PartnerSummary>>('GET', '/v1/bp/partners?partnerType=supplier&status=active&limit=200'),
    ]).then(([g, u, w, l, v]) => {
      if (g.ok) setGroups(g.body);
      if (u.ok) setUnits(u.body);
      if (w.ok) setWarehouses(w.body);
      if (l.ok) setLists(l.body);
      if (v.ok) setVendors(v.body.items);
    });
  }, [call]);

  const dirty = mode === 'update' || (mode === 'add' && (draft.code !== '' || draft.name !== ''));
  const confirmDiscard = useCallback(() => !dirty || window.confirm('Discard unsaved changes to this item?'), [dirty]);
  const resetMessages = () => {
    setError(null);
    setNotice(null);
    setFields({});
  };

  const show = useCallback((item: Item) => {
    setRecord(item);
    setDraft(toDraft(item));
    setMode('ok');
  }, []);

  const loadById = useCallback(
    async (id: string) => {
      const result = await call<Item>('GET', `/v1/inv/items/${id}`);
      if (result.ok) show(result.body);
      else setError(errorMessage(result));
    },
    [call, show],
  );

  const enterFind = useCallback(() => {
    if (!confirmDiscard()) return;
    resetMessages();
    setRecord(null);
    setDraft(emptyDraft(groups, units, warehouses));
    setMode('find');
  }, [confirmDiscard, groups, units, warehouses]);

  const enterAdd = useCallback(() => {
    if (!canCreate || !confirmDiscard()) return;
    resetMessages();
    setRecord(null);
    setDraft(emptyDraft(groups, units, warehouses));
    setTab('general');
    setMode('add');
  }, [canCreate, confirmDiscard, groups, units, warehouses]);

  const navigate = useCallback(
    async (direction: 'first' | 'previous' | 'next' | 'last') => {
      if (!confirmDiscard()) return;
      resetMessages();
      const result = await call<Page<ItemSummary>>('GET', '/v1/inv/items?limit=200');
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      const items = result.body.items;
      if (items.length === 0) {
        setNotice('No items have been defined.');
        return;
      }
      const index = record ? items.findIndex((item) => item.id === record.id) : -1;
      const target =
        direction === 'first'
          ? items[0]
          : direction === 'last'
            ? items[items.length - 1]
            : direction === 'next'
              ? items[index < 0 ? 0 : Math.min(index + 1, items.length - 1)]
              : items[index < 0 ? items.length - 1 : Math.max(index - 1, 0)];
      if (target) await loadById(target.id);
    },
    [call, confirmDiscard, loadById, record],
  );

  useRecordToolbar({
    find: enterFind,
    add: canCreate ? enterAdd : undefined,
    first: () => void navigate('first'),
    previous: () => void navigate('previous'),
    next: () => void navigate('next'),
    last: () => void navigate('last'),
  });

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (mode === 'ok' && canEdit) setMode('update');
  };

  const find = async () => {
    const term = (draft.code || draft.name).trim();
    const query = new URLSearchParams({ limit: '200' });
    if (term) query.set('search', term);
    const result = await call<Page<ItemSummary>>('GET', `/v1/inv/items?${query.toString()}`);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    const exact = result.body.items.find((item) => item.code.toLowerCase() === term.toLowerCase());
    if (exact) await loadById(exact.id);
    else if (result.body.items.length === 1 && result.body.items[0]) await loadById(result.body.items[0].id);
    else if (result.body.items.length === 0) setError('No matching records found.');
    else setChoices(result.body.items);
  };

  const payload = () => {
    const stocked = draft.itemType === 'inventory';
    return {
      name: draft.name,
      foreignName: draft.foreignName,
      itemType: draft.itemType,
      isSalesItem: draft.isSalesItem,
      isPurchaseItem: draft.isPurchaseItem,
      groupId: draft.groupId,
      uomId: draft.uomId,
      barcode: draft.barcode,
      defaultWarehouseId: stocked ? draft.defaultWarehouseId || null : null,
      reorderPoint: stocked ? draft.reorderPoint.trim() || null : null,
      preferredVendorId: draft.preferredVendorId || null,
      status: draft.status,
      remarks: draft.remarks,
      prices: Object.entries(draft.prices)
        .filter(([, price]) => price.trim() !== '')
        .map(([priceListId, price]) => ({ priceListId, price: price.replace(/,/g, '').trim() })),
    };
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    resetMessages();
    if (mode === 'find') {
      await find();
      return;
    }
    if (mode === 'ok') {
      onClose();
      return;
    }
    setBusy(true);
    const result =
      mode === 'add'
        ? await call<Item>('POST', '/v1/inv/items', { code: draft.code, ...payload() })
        : await call<Item>('PUT', `/v1/inv/items/${record?.id}`, { version: record?.version, ...payload() });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      setFields(fieldErrors(result));
      return;
    }
    setNotice(mode === 'add' ? `Item ${result.body.code} added.` : 'Operation completed successfully.');
    show(result.body);
  };

  const cancel = () => {
    if (confirmDiscard()) onClose();
  };

  const editable = mode === 'add' || mode === 'update' || (mode === 'ok' && canEdit);
  const primaryLabel = mode === 'find' ? 'Find' : mode === 'add' ? 'Add' : mode === 'update' ? 'Update' : 'OK';
  const unitCode = units.find((unit) => unit.id === draft.uomId)?.code ?? '';

  return (
    <form onSubmit={submit} noValidate>
      <FormWindow
        title={`Item Master Data${mode === 'find' ? ' - Find' : mode === 'add' ? ' - Add' : ''}`}
        onClose={cancel}
        footerLeft={
          <>
            <Button type="submit" variant="primary" busy={busy}>
              {primaryLabel}
            </Button>
            <Button type="button" onClick={cancel}>
              Cancel
            </Button>
          </>
        }
        footerRight={<span className="ui-muted">{mode === 'find' ? 'Enter an item number, name or barcode and choose Find.' : record ? `Version ${record.version}` : ''}</span>}
      >
        {error ? <Banner>{error}</Banner> : null}
        {notice ? <Banner tone="info">{notice}</Banner> : null}
        <div className="form-columns">
          <div>
            <Row label="Item No." error={fields.code}>
              <input className="grid-input" value={draft.code} maxLength={40} readOnly={mode === 'ok' || mode === 'update'} onChange={(e) => setDraft((c) => ({ ...c, code: e.target.value }))} autoFocus />
            </Row>
            <Row label="Description" error={fields.name}>
              <input
                className="grid-input"
                value={draft.name}
                maxLength={200}
                readOnly={!(editable || mode === 'find')}
                onChange={(e) => (mode === 'find' ? setDraft((c) => ({ ...c, name: e.target.value })) : update('name', e.target.value))}
              />
            </Row>
            <Row label="Foreign Name">
              <input className="grid-input" value={draft.foreignName} readOnly={!editable} onChange={(e) => update('foreignName', e.target.value)} />
            </Row>
            <Row label="Item Type">
              <select className="grid-input" value={draft.itemType} disabled={!editable} onChange={(e) => update('itemType', e.target.value as ItemType)}>
                {(Object.keys(TYPE_LABELS) as ItemType[]).map((type) => (
                  <option key={type} value={type}>
                    {TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </Row>
          </div>
          <div>
            <Row label="Item Group" error={fields.groupId}>
              <select className="grid-input" value={draft.groupId} disabled={!editable} onChange={(e) => update('groupId', e.target.value)}>
                {groups
                  .filter((group) => group.status === 'active' || group.id === draft.groupId)
                  .map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
              </select>
            </Row>
            <Row label="Unit of Measure" error={fields.uomId}>
              <select className="grid-input" value={draft.uomId} disabled={!editable} onChange={(e) => update('uomId', e.target.value)}>
                {units
                  .filter((unit) => unit.status === 'active' || unit.id === draft.uomId)
                  .map((unit) => (
                    <option key={unit.id} value={unit.id}>
                      {unit.code} - {unit.name}
                    </option>
                  ))}
              </select>
            </Row>
            <Row label="Bar Code" error={fields.barcode}>
              <input className="grid-input" value={draft.barcode} maxLength={60} readOnly={!editable} onChange={(e) => update('barcode', e.target.value)} />
            </Row>
            <div className="ui-field">
              <span>Flags</span>
              <span className="flag-row">
                <label>
                  <input type="checkbox" checked={draft.itemType === 'inventory'} disabled readOnly /> Inventory Item
                </label>
                <label>
                  <input type="checkbox" checked={draft.isSalesItem} disabled={!editable} onChange={(e) => update('isSalesItem', e.target.checked)} /> Sales Item
                </label>
                <label>
                  <input type="checkbox" checked={draft.isPurchaseItem} disabled={!editable} onChange={(e) => update('isPurchaseItem', e.target.checked)} /> Purchase Item
                </label>
              </span>
            </div>
          </div>
        </div>
        {fields.isSalesItem ? <Banner>{fields.isSalesItem}</Banner> : null}

        {mode !== 'find' ? (
          <>
            <div className="tabs" role="tablist" aria-label="Item details">
              {(
                [
                  ['general', 'General'],
                  ['prices', 'Prices'],
                  ['inventory', 'Inventory Data'],
                  ['remarks', 'Remarks'],
                ] as [Tab, string][]
              ).map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} className="tabs__tab" onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="tabs__panel" role="tabpanel">
              {tab === 'general' ? (
                <div className="form-columns">
                  <div>
                    <Row label="Preferred Vendor" error={fields.preferredVendorId}>
                      <select className="grid-input" value={draft.preferredVendorId} disabled={!editable} onChange={(e) => update('preferredVendorId', e.target.value)}>
                        <option value="" />
                        {vendors.map((vendor) => (
                          <option key={vendor.id} value={vendor.id}>
                            {vendor.code} - {vendor.name}
                          </option>
                        ))}
                      </select>
                    </Row>
                    <Row label="Status">
                      <select className="grid-input" value={draft.status} disabled={!editable} onChange={(e) => update('status', e.target.value as 'active' | 'inactive')}>
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                      </select>
                    </Row>
                  </div>
                  <div>{record ? <StatusBadge status={record.status} /> : null}</div>
                </div>
              ) : null}
              {tab === 'prices' ? (
                <>
                  {fields.prices ? <Banner>{fields.prices}</Banner> : null}
                  <div className="ui-table-wrap">
                    <table className="ui-table">
                      <thead>
                        <tr>
                          <th>Price List</th>
                          <th>Used For</th>
                          <th className="numeric">Unit Price</th>
                          <th>Currency</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lists
                          .filter((list) => list.status === 'active')
                          .map((list) => (
                            <tr key={list.id}>
                              <td>
                                {list.name}
                                {list.isDefault ? ' (default)' : ''}
                              </td>
                              <td>{list.purpose === 'sales' ? 'Sales' : 'Purchasing'}</td>
                              <td>
                                <input
                                  className="grid-input grid-input--number"
                                  inputMode="decimal"
                                  aria-label={`${list.name} price`}
                                  value={draft.prices[list.id] ?? ''}
                                  readOnly={!editable}
                                  onChange={(e) => update('prices', { ...draft.prices, [list.id]: e.target.value })}
                                />
                              </td>
                              <td>{list.currency}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="ui-muted">Prices are per {unitCode || 'unit'}. Leave a price empty to remove it from that price list.</p>
                </>
              ) : null}
              {tab === 'inventory' ? (
                draft.itemType === 'inventory' ? (
                  <div className="form-columns">
                    <div>
                      <Row label="Default Warehouse" error={fields.defaultWarehouseId}>
                        <select className="grid-input" value={draft.defaultWarehouseId} disabled={!editable} onChange={(e) => update('defaultWarehouseId', e.target.value)}>
                          <option value="" />
                          {warehouses
                            .filter((warehouse) => warehouse.status === 'active' || warehouse.id === draft.defaultWarehouseId)
                            .map((warehouse) => (
                              <option key={warehouse.id} value={warehouse.id}>
                                {warehouse.code} - {warehouse.name}
                              </option>
                            ))}
                        </select>
                      </Row>
                      <Row label={`Minimum (${unitCode})`} error={fields.reorderPoint}>
                        <input className="grid-input grid-input--number" inputMode="decimal" value={draft.reorderPoint} readOnly={!editable} onChange={(e) => update('reorderPoint', e.target.value)} />
                      </Row>
                    </div>
                    <div>{record && canViewStock ? <ItemStockPanel call={call} itemId={record.id} /> : <p className="ui-muted">Stock figures appear after the item is added.</p>}</div>
                  </div>
                ) : (
                  <p className="ui-muted">{TYPE_LABELS[draft.itemType]}s are not stocked and have no warehouse data.</p>
                )
              ) : null}
              {tab === 'remarks' ? (
                <textarea className="grid-input grid-textarea grid-textarea--wide" aria-label="Remarks" value={draft.remarks} readOnly={!editable} onChange={(e) => update('remarks', e.target.value)} />
              ) : null}
            </div>
          </>
        ) : null}
      </FormWindow>
      {choices ? (
        <div className="modal-backdrop" role="presentation">
          <FormWindow
            title="List of Items"
            width={640}
            onClose={() => setChoices(null)}
            footerLeft={
              <Button type="button" onClick={() => setChoices(null)}>
                Cancel
              </Button>
            }
          >
            <div className="ui-table-wrap">
              <table className="ui-table company-grid">
                <thead>
                  <tr>
                    <th>Item No.</th>
                    <th>Description</th>
                    <th>Type</th>
                    <th>Group</th>
                    <th>UoM</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {choices.map((item) => (
                    <tr
                      key={item.id}
                      onDoubleClick={() => {
                        setChoices(null);
                        void loadById(item.id);
                      }}
                    >
                      <td>{item.code}</td>
                      <td>{item.name}</td>
                      <td>{TYPE_LABELS[item.itemType]}</td>
                      <td>{item.groupName}</td>
                      <td>{item.uomCode}</td>
                      <td>
                        <StatusBadge status={item.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="ui-muted">Double-click an item to open it.</p>
          </FormWindow>
        </div>
      ) : null}
    </form>
  );
}

function Row({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="ui-field">
      <span>{label}</span>
      {children}
      {error ? (
        <span className="ui-field-error" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}
