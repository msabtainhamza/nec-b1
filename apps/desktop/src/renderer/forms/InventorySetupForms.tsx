import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Account, Branch, ItemGroup, Page, PriceList, PriceListEntry, UnitOfMeasure, Warehouse } from '@nec/contracts';
import { Banner, Button, DataTable, FormWindow, StatusBadge } from '@nec/ui';
import { errorMessage } from '../api';
import type { ApiCall } from '../screens/Shell';

function useLoad<T>(call: ApiCall, path: string, initial: T) {
  const [data, setData] = useState<T>(initial);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const result = await call<T>('GET', path);
    if (result.ok) {
      setData(result.body);
      setError(null);
    } else {
      setError(errorMessage(result));
    }
  }, [call, path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, setData, error, setError, reload };
}

function accountLabel(accounts: Account[], id: string | null): string {
  if (!id) return '';
  const account = accounts.find((row) => row.id === id);
  return account ? `${account.code} - ${account.name}` : '';
}

function AccountSelect({ accounts, types, value, onChange, label }: { accounts: Account[]; types: string[]; value: string; onChange: (value: string) => void; label: string }) {
  return (
    <select className="grid-input" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Use G/L determination</option>
      {accounts
        .filter((account) => !account.isTitle && account.status === 'active' && !account.controlKind && types.includes(account.accountType))
        .map((account) => (
          <option key={account.id} value={account.id}>
            {account.code} - {account.name}
          </option>
        ))}
    </select>
  );
}

export function WarehousesForm({ call, canAdminister, onClose }: { call: ApiCall; canAdminister: boolean; onClose: () => void }) {
  const warehouses = useLoad<Warehouse[]>(call, '/v1/inv/warehouses', []);
  const branches = useLoad<Branch[]>(call, '/v1/tenant/branches', []);
  const accounts = useLoad<Account[]>(call, '/v1/fin/accounts', []);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [branchId, setBranchId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setNotice(null);
    warehouses.setError(null);
    setBusy(true);
    const result = await call<Warehouse>('POST', '/v1/inv/warehouses', { code, name, branchId, inventoryAccountId: accountId || null });
    setBusy(false);
    if (!result.ok) {
      warehouses.setError(errorMessage(result));
      return;
    }
    setNotice(`Warehouse ${result.body.code} added.`);
    setCode('');
    setName('');
    await warehouses.reload();
  };

  const toggle = async (warehouse: Warehouse) => {
    const status = warehouse.status === 'active' ? 'inactive' : 'active';
    const result = await call<Warehouse>('PUT', `/v1/inv/warehouses/${warehouse.id}`, {
      version: warehouse.version,
      name: warehouse.name,
      inventoryAccountId: warehouse.inventoryAccountId,
      status,
    });
    if (!result.ok) warehouses.setError(errorMessage(result));
    await warehouses.reload();
  };

  return (
    <FormWindow title="Warehouses - Setup" onClose={onClose} footerLeft={<Button type="button" variant="primary" onClick={onClose}>OK</Button>}>
      {warehouses.error ? <Banner>{warehouses.error}</Banner> : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}
      <DataTable
        rowNumbers
        rows={warehouses.data}
        rowKey={(row) => row.id}
        empty="No warehouses."
        columns={[
          { key: 'code', header: 'Warehouse Code', render: (row) => row.code },
          { key: 'name', header: 'Warehouse Name', render: (row) => row.name },
          { key: 'branch', header: 'Branch', render: (row) => `${row.branchCode}${row.isBranchDefault ? ' (default)' : ''}` },
          { key: 'account', header: 'Inventory Account', render: (row) => accountLabel(accounts.data, row.inventoryAccountId) || 'G/L determination' },
          { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
          {
            key: 'active',
            header: 'Active',
            render: (row) => <input type="checkbox" aria-label={`Warehouse ${row.code} active`} checked={row.status === 'active'} disabled={!canAdminister} onChange={() => void toggle(row)} />,
          },
        ]}
      />
      {canAdminister ? (
        <form onSubmit={add} noValidate>
          <div className="form-section">New Warehouse</div>
          <div className="inline-fields inline-fields--five">
            <label className="ui-field">
              <span>Code</span>
              <input className="grid-input" value={code} maxLength={20} onChange={(e) => setCode(e.target.value)} />
            </label>
            <label className="ui-field">
              <span>Name</span>
              <input className="grid-input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="ui-field">
              <span>Branch</span>
              <select className="grid-input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="" />
                {branches.data
                  .filter((branch) => branch.status === 'active')
                  .map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.code} - {branch.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="ui-field">
              <span>Inventory Account</span>
              <AccountSelect accounts={accounts.data} types={['asset']} value={accountId} onChange={setAccountId} label="Inventory account" />
            </label>
            <Button type="submit" variant="primary" busy={busy} disabled={!code || !name || !branchId}>
              Add
            </Button>
          </div>
        </form>
      ) : null}
    </FormWindow>
  );
}

export function UnitsOfMeasureForm({ call, canAdminister, onClose }: { call: ApiCall; canAdminister: boolean; onClose: () => void }) {
  const units = useLoad<UnitOfMeasure[]>(call, '/v1/inv/units', []);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [decimals, setDecimals] = useState('0');
  const [busy, setBusy] = useState(false);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const result = await call<UnitOfMeasure>('POST', '/v1/inv/units', { code, name, decimals: Number(decimals) });
    setBusy(false);
    if (!result.ok) {
      units.setError(errorMessage(result));
      return;
    }
    setCode('');
    setName('');
    await units.reload();
  };

  return (
    <FormWindow title="Units of Measure - Setup" onClose={onClose} width={640} footerLeft={<Button type="button" variant="primary" onClick={onClose}>OK</Button>}>
      {units.error ? <Banner>{units.error}</Banner> : null}
      <DataTable
        rowNumbers
        rows={units.data}
        rowKey={(row) => row.id}
        empty="No units."
        columns={[
          { key: 'code', header: 'UoM Code', render: (row) => row.code },
          { key: 'name', header: 'UoM Name', render: (row) => row.name },
          { key: 'decimals', header: 'Decimals', render: (row) => row.decimals },
          { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
        ]}
      />
      {canAdminister ? (
        <form onSubmit={add} noValidate>
          <div className="form-section">New Unit</div>
          <div className="inline-fields inline-fields--four">
            <label className="ui-field">
              <span>Code</span>
              <input className="grid-input" value={code} maxLength={10} onChange={(e) => setCode(e.target.value)} />
            </label>
            <label className="ui-field">
              <span>Name</span>
              <input className="grid-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="ui-field">
              <span>Decimals</span>
              <select className="grid-input" value={decimals} onChange={(e) => setDecimals(e.target.value)}>
                {[0, 1, 2, 3, 4].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" variant="primary" busy={busy} disabled={!code || !name}>
              Add
            </Button>
          </div>
        </form>
      ) : null}
      <p className="ui-muted">Each item uses one base unit in this release; quantities are limited to the unit's decimal places.</p>
    </FormWindow>
  );
}

export function ItemGroupsForm({ call, canAdminister, onClose }: { call: ApiCall; canAdminister: boolean; onClose: () => void }) {
  const groups = useLoad<ItemGroup[]>(call, '/v1/inv/item-groups', []);
  const accounts = useLoad<Account[]>(call, '/v1/fin/accounts', []);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [inventory, setInventory] = useState('');
  const [cogs, setCogs] = useState('');
  const [revenue, setRevenue] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const result = await call<ItemGroup>('POST', '/v1/inv/item-groups', {
      code,
      name,
      inventoryAccountId: inventory || null,
      cogsAccountId: cogs || null,
      revenueAccountId: revenue || null,
    });
    setBusy(false);
    if (!result.ok) {
      groups.setError(errorMessage(result));
      return;
    }
    setCode('');
    setName('');
    await groups.reload();
  };

  return (
    <FormWindow title="Item Groups - Setup" onClose={onClose} footerLeft={<Button type="button" variant="primary" onClick={onClose}>OK</Button>}>
      {groups.error ? <Banner>{groups.error}</Banner> : null}
      <DataTable
        rowNumbers
        rows={groups.data}
        rowKey={(row) => row.id}
        empty="No item groups."
        columns={[
          { key: 'code', header: 'Code', render: (row) => row.code },
          { key: 'name', header: 'Group Name', render: (row) => row.name },
          { key: 'inventory', header: 'Inventory Account', render: (row) => accountLabel(accounts.data, row.inventoryAccountId) || 'G/L determination' },
          { key: 'cogs', header: 'Cost of Goods Sold', render: (row) => accountLabel(accounts.data, row.cogsAccountId) || 'G/L determination' },
          { key: 'revenue', header: 'Revenue Account', render: (row) => accountLabel(accounts.data, row.revenueAccountId) || 'G/L determination' },
        ]}
      />
      {canAdminister ? (
        <form onSubmit={add} noValidate>
          <div className="form-section">New Item Group</div>
          <div className="form-columns">
            <div>
              <label className="ui-field">
                <span>Code</span>
                <input className="grid-input" value={code} maxLength={20} onChange={(e) => setCode(e.target.value)} />
              </label>
              <label className="ui-field">
                <span>Group Name</span>
                <input className="grid-input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
              </label>
            </div>
            <div>
              <label className="ui-field">
                <span>Inventory Account</span>
                <AccountSelect accounts={accounts.data} types={['asset']} value={inventory} onChange={setInventory} label="Inventory account" />
              </label>
              <label className="ui-field">
                <span>Cost of Goods Sold</span>
                <AccountSelect accounts={accounts.data} types={['expense']} value={cogs} onChange={setCogs} label="Cost of goods sold account" />
              </label>
              <label className="ui-field">
                <span>Revenue Account</span>
                <AccountSelect accounts={accounts.data} types={['income']} value={revenue} onChange={setRevenue} label="Revenue account" />
              </label>
            </div>
          </div>
          <Button type="submit" variant="primary" busy={busy} disabled={!code || !name}>
            Add
          </Button>
        </form>
      ) : null}
    </FormWindow>
  );
}

export function PriceListsForm({ call, canAdminister, onClose }: { call: ApiCall; canAdminister: boolean; onClose: () => void }) {
  const lists = useLoad<PriceList[]>(call, '/v1/inv/price-lists', []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [entries, setEntries] = useState<PriceListEntry[]>([]);
  const [search, setSearch] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState<'sales' | 'purchase'>('sales');

  const selected = lists.data.find((list) => list.id === selectedId) ?? null;

  const loadEntries = useCallback(async () => {
    if (!selectedId) return;
    const query = new URLSearchParams({ limit: '200' });
    if (search.trim()) query.set('search', search.trim());
    const result = await call<Page<PriceListEntry>>('GET', `/v1/inv/price-lists/${selectedId}/prices?${query.toString()}`);
    if (result.ok) setEntries(result.body.items);
    else lists.setError(errorMessage(result));
  }, [call, lists, search, selectedId]);

  useEffect(() => {
    setEdits({});
    void loadEntries();
  }, [selectedId]);

  const save = async () => {
    if (!selectedId || busy || Object.keys(edits).length === 0) return;
    setBusy(true);
    setNotice(null);
    const result = await call('PUT', `/v1/inv/price-lists/${selectedId}/prices`, {
      prices: Object.entries(edits).map(([itemId, price]) => ({ itemId, price: price.trim() === '' ? null : price.replace(/,/g, '').trim() })),
    });
    setBusy(false);
    if (!result.ok) {
      lists.setError(errorMessage(result));
      return;
    }
    setEdits({});
    setNotice('Prices updated.');
    await loadEntries();
  };

  const addList = async (event: FormEvent) => {
    event.preventDefault();
    const result = await call<PriceList>('POST', '/v1/inv/price-lists', { code, name, purpose });
    if (!result.ok) {
      lists.setError(errorMessage(result));
      return;
    }
    setCode('');
    setName('');
    await lists.reload();
    setSelectedId(result.body.id);
  };

  const dirty = Object.keys(edits).length > 0;

  return (
    <FormWindow
      title="Price Lists"
      onClose={onClose}
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
      {lists.error ? <Banner>{lists.error}</Banner> : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}
      <div className="ui-table-wrap">
        <table className="ui-table company-grid">
          <thead>
            <tr>
              <th>Price List Name</th>
              <th>Used For</th>
              <th>Currency</th>
              <th>Valid From</th>
              <th>Valid To</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {lists.data.map((list) => (
              <tr key={list.id} aria-selected={list.id === selectedId} onClick={() => setSelectedId(list.id)}>
                <td>
                  {list.name}
                  {list.isDefault ? ' (default)' : ''}
                </td>
                <td>{list.purpose === 'sales' ? 'Sales' : 'Purchasing'}</td>
                <td>{list.currency}</td>
                <td>{list.validFrom ?? ''}</td>
                <td>{list.validTo ?? ''}</td>
                <td>
                  <StatusBadge status={list.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected ? (
        <>
          <div className="form-section">Prices in {selected.name}</div>
          <div className="pager">
            <input className="grid-input" style={{ width: 240 }} aria-label="Search items" placeholder="Item number or description" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Button type="button" onClick={() => void loadEntries()}>
              Find
            </Button>
          </div>
          <DataTable
            rowNumbers
            rows={entries}
            rowKey={(row) => row.itemId}
            empty="No items."
            columns={[
              { key: 'code', header: 'Item No.', render: (row) => row.itemCode },
              { key: 'name', header: 'Item Description', render: (row) => row.itemName },
              { key: 'uom', header: 'UoM', render: (row) => row.uomCode },
              {
                key: 'price',
                header: `Unit Price (${selected.currency})`,
                render: (row) => (
                  <input
                    className="grid-input grid-input--number"
                    inputMode="decimal"
                    aria-label={`Price for ${row.itemCode}`}
                    readOnly={!canAdminister || selected.status !== 'active'}
                    value={edits[row.itemId] ?? (row.price ? row.price.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : '')}
                    onChange={(e) => setEdits((current) => ({ ...current, [row.itemId]: e.target.value }))}
                  />
                ),
              },
            ]}
          />
        </>
      ) : (
        <p className="ui-muted">Select a price list to view or edit its item prices.</p>
      )}
      {canAdminister ? (
        <form onSubmit={addList} noValidate>
          <div className="form-section">New Price List</div>
          <div className="inline-fields inline-fields--four">
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
              <select className="grid-input" value={purpose} onChange={(e) => setPurpose(e.target.value as 'sales' | 'purchase')}>
                <option value="sales">Sales</option>
                <option value="purchase">Purchasing</option>
              </select>
            </label>
            <Button type="submit" variant="primary" disabled={!code || !name}>
              Add
            </Button>
          </div>
        </form>
      ) : null}
    </FormWindow>
  );
}
