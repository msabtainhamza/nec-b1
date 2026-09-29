import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { BusinessPartner, Page, PartnerBalance, PartnerGroup, PartnerSummary, PartnerType, PaymentTerms } from '@nec/contracts';
import { formatAmount } from '../format';
import { Banner, Button, DataTable, FormWindow, StatusBadge } from '@nec/ui';
import { errorMessage, fieldErrors } from '../api';
import type { ApiCall } from '../screens/Shell';
import { useRecordToolbar } from '../toolbar';

type Mode = 'find' | 'add' | 'ok' | 'update';
type Tab = 'general' | 'contacts' | 'addresses' | 'payment';

interface ContactDraft {
  key: string;
  name: string;
  position: string;
  phone: string;
  email: string;
  isDefault: boolean;
}

interface AddressDraft {
  key: string;
  addressType: 'bill_to' | 'ship_to';
  addressName: string;
  street: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  isDefault: boolean;
}

interface Draft {
  code: string;
  partnerType: PartnerType;
  name: string;
  foreignName: string;
  groupId: string;
  taxId: string;
  phone: string;
  email: string;
  website: string;
  paymentTermsId: string;
  creditLimit: string;
  status: 'active' | 'inactive';
  remarks: string;
  contacts: ContactDraft[];
  addresses: AddressDraft[];
}

const TYPE_LABELS: Record<PartnerType, string> = { customer: 'Customer', supplier: 'Vendor', lead: 'Lead' };

let keySeed = 0;
const nextKey = () => `row-${++keySeed}`;

function emptyDraft(): Draft {
  return {
    code: '',
    partnerType: 'customer',
    name: '',
    foreignName: '',
    groupId: '',
    taxId: '',
    phone: '',
    email: '',
    website: '',
    paymentTermsId: '',
    creditLimit: '0',
    status: 'active',
    remarks: '',
    contacts: [],
    addresses: [],
  };
}

function toDraft(partner: BusinessPartner): Draft {
  return {
    code: partner.code,
    partnerType: partner.partnerType,
    name: partner.name,
    foreignName: partner.foreignName ?? '',
    groupId: partner.groupId ?? '',
    taxId: partner.taxId ?? '',
    phone: partner.phone ?? '',
    email: partner.email ?? '',
    website: partner.website ?? '',
    paymentTermsId: partner.paymentTermsId ?? '',
    creditLimit: partner.creditLimit.replace(/\.?0+$/, '') || '0',
    status: partner.status,
    remarks: partner.remarks ?? '',
    contacts: partner.contacts.map((contact) => ({
      key: nextKey(),
      name: contact.name,
      position: contact.position ?? '',
      phone: contact.phone ?? '',
      email: contact.email ?? '',
      isDefault: contact.isDefault,
    })),
    addresses: partner.addresses.map((address) => ({
      key: nextKey(),
      addressType: address.addressType,
      addressName: address.addressName,
      street: address.street ?? '',
      city: address.city ?? '',
      state: address.state ?? '',
      zipCode: address.zipCode ?? '',
      country: address.country ?? '',
      isDefault: address.isDefault,
    })),
  };
}

function toPayload(draft: Draft) {
  return {
    partnerType: draft.partnerType,
    name: draft.name,
    foreignName: draft.foreignName,
    groupId: draft.groupId || null,
    taxId: draft.taxId,
    phone: draft.phone,
    email: draft.email,
    website: draft.website,
    paymentTermsId: draft.paymentTermsId || null,
    creditLimit: draft.creditLimit.trim() || '0',
    status: draft.status,
    remarks: draft.remarks,
    contacts: draft.contacts
      .filter((contact) => contact.name.trim() !== '')
      .map(({ key: _key, ...contact }) => contact),
    addresses: draft.addresses
      .filter((address) => address.addressName.trim() !== '')
      .map(({ key: _key, ...address }) => address),
  };
}

export function BusinessPartnerForm({
  call,
  canCreate,
  canEdit,
  currency,
  onClose,
}: {
  call: ApiCall;
  canCreate: boolean;
  canEdit: boolean;
  currency: string;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>('find');
  const [tab, setTab] = useState<Tab>('general');
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [record, setRecord] = useState<BusinessPartner | null>(null);
  const [groups, setGroups] = useState<PartnerGroup[]>([]);
  const [terms, setTerms] = useState<PaymentTerms[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<PartnerSummary[] | null>(null);
  const [balance, setBalance] = useState<PartnerBalance | null>(null);

  useEffect(() => {
    setBalance(null);
    if (!record) return;
    void call<PartnerBalance>('GET', `/v1/bp/partners/${record.id}/balance`).then((result) => {
      if (result.ok) setBalance(result.body);
    });
  }, [call, record]);

  useEffect(() => {
    void Promise.all([call<PartnerGroup[]>('GET', '/v1/bp/groups'), call<PaymentTerms[]>('GET', '/v1/bp/payment-terms')]).then(
      ([groupResult, termsResult]) => {
        if (groupResult.ok) setGroups(groupResult.body);
        if (termsResult.ok) setTerms(termsResult.body);
      },
    );
  }, [call]);

  const dirty = mode === 'update' || (mode === 'add' && (draft.code !== '' || draft.name !== ''));

  const confirmDiscard = useCallback(
    () => !dirty || window.confirm('Discard unsaved changes to this business partner?'),
    [dirty],
  );

  const resetMessages = () => {
    setError(null);
    setNotice(null);
    setFields({});
  };

  const show = useCallback((partner: BusinessPartner) => {
    setRecord(partner);
    setDraft(toDraft(partner));
    setMode('ok');
  }, []);

  const loadById = useCallback(
    async (id: string) => {
      const result = await call<BusinessPartner>('GET', `/v1/bp/partners/${id}`);
      if (result.ok) {
        show(result.body);
      } else {
        setError(errorMessage(result));
      }
    },
    [call, show],
  );

  const enterFind = useCallback(() => {
    if (!confirmDiscard()) return;
    resetMessages();
    setRecord(null);
    setDraft(emptyDraft());
    setMode('find');
  }, [confirmDiscard]);

  const enterAdd = useCallback(() => {
    if (!canCreate || !confirmDiscard()) return;
    resetMessages();
    setRecord(null);
    setDraft(emptyDraft());
    setTab('general');
    setMode('add');
  }, [canCreate, confirmDiscard]);

  const navigate = useCallback(
    async (direction: 'first' | 'previous' | 'next' | 'last') => {
      if (!confirmDiscard()) return;
      resetMessages();
      const result = await call<Page<PartnerSummary>>('GET', '/v1/bp/partners?limit=200');
      if (!result.ok) {
        setError(errorMessage(result));
        return;
      }
      const items = result.body.items;
      if (items.length === 0) {
        setNotice('No business partners have been defined.');
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
      if (target) {
        await loadById(target.id);
      }
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
    if (mode === 'ok') {
      setMode(canEdit ? 'update' : 'ok');
    }
  };

  const find = async () => {
    const term = (draft.code || draft.name).trim();
    const query = new URLSearchParams({ limit: '200' });
    if (term) query.set('search', term);
    const result = await call<Page<PartnerSummary>>('GET', `/v1/bp/partners?${query.toString()}`);
    if (!result.ok) {
      setError(errorMessage(result));
      return;
    }
    const exact = result.body.items.find((item) => item.code.toLowerCase() === term.toLowerCase());
    if (exact) {
      await loadById(exact.id);
    } else if (result.body.items.length === 1 && result.body.items[0]) {
      await loadById(result.body.items[0].id);
    } else if (result.body.items.length === 0) {
      setError('No matching records found.');
    } else {
      setChoices(result.body.items);
    }
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
        ? await call<BusinessPartner>('POST', '/v1/bp/partners', { code: draft.code, ...toPayload(draft), currency })
        : await call<BusinessPartner>('PUT', `/v1/bp/partners/${record?.id}`, { version: record?.version, ...toPayload(draft), currency });
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result));
      setFields(fieldErrors(result));
      return;
    }
    setNotice(mode === 'add' ? `Business partner ${result.body.code} added.` : 'Operation completed successfully.');
    show(result.body);
  };

  const cancel = () => {
    if (confirmDiscard()) onClose();
  };

  const primaryLabel = mode === 'find' ? 'Find' : mode === 'add' ? 'Add' : mode === 'update' ? 'Update' : 'OK';
  const editable = mode === 'add' || mode === 'update' || (mode === 'ok' && canEdit);
  const headerEditable = mode !== 'find' && editable;
  const groupOptions = groups.filter((group) => group.partnerType === (draft.partnerType === 'supplier' ? 'supplier' : 'customer'));

  return (
    <form onSubmit={submit} noValidate>
      <FormWindow
        title={`Business Partner Master Data${mode === 'find' ? ' - Find' : mode === 'add' ? ' - Add' : ''}`}
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
        footerRight={
          <span className="ui-muted">
            {mode === 'find' ? 'Enter a code or name and choose Find, or use the record arrows.' : record ? `Version ${record.version}` : ''}
          </span>
        }
      >
        {error ? <Banner>{error}</Banner> : null}
        {notice ? <Banner tone="info">{notice}</Banner> : null}
        <div className="form-columns">
          <div>
            <Row label="Code" error={fields.code}>
              <input
                className="grid-input"
                value={draft.code}
                maxLength={30}
                readOnly={mode === 'ok' || mode === 'update'}
                onChange={(e) => setDraft((current) => ({ ...current, code: e.target.value }))}
                aria-invalid={fields.code ? true : undefined}
                autoFocus
              />
            </Row>
            <Row label="Type">
              <select
                className="grid-input"
                value={draft.partnerType}
                disabled={!headerEditable || (record !== null && record.partnerType !== 'lead')}
                onChange={(e) => update('partnerType', e.target.value as PartnerType)}
              >
                {(Object.keys(TYPE_LABELS) as PartnerType[]).map((type) => (
                  <option key={type} value={type} disabled={record?.partnerType === 'lead' && type === 'supplier'}>
                    {TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Name" error={fields.name}>
              <input
                className="grid-input"
                value={draft.name}
                maxLength={200}
                readOnly={!(editable || mode === 'find')}
                onChange={(e) => (mode === 'find' ? setDraft((current) => ({ ...current, name: e.target.value })) : update('name', e.target.value))}
                aria-invalid={fields.name ? true : undefined}
              />
            </Row>
            <Row label="Foreign Name">
              <input className="grid-input" value={draft.foreignName} readOnly={!headerEditable} onChange={(e) => update('foreignName', e.target.value)} />
            </Row>
            <Row label="Group" error={fields.groupId}>
              <select className="grid-input" value={draft.groupId} disabled={!headerEditable} onChange={(e) => update('groupId', e.target.value)}>
                <option value="" />
                {groupOptions.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Currency" error={fields.currency}>
              <span className="form-value">{currency}</span>
            </Row>
          </div>
          <div>
            <Row label="Federal Tax ID">
              <input className="grid-input" value={draft.taxId} readOnly={!headerEditable} onChange={(e) => update('taxId', e.target.value)} />
            </Row>
            <Row label="Status">
              <select
                className="grid-input"
                value={draft.status}
                disabled={!headerEditable}
                onChange={(e) => update('status', e.target.value as 'active' | 'inactive')}
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </Row>
            {record ? (
              <Row label="Current Status">
                <span>
                  <StatusBadge status={record.status} />
                </span>
              </Row>
            ) : null}
            {record ? (
              <Row label="Account Balance">
                <span className="form-value">
                  {balance ? `${formatAmount(balance.balance)} ${balance.currency}${balance.openInvoices ? ` (${balance.openInvoices} open invoices)` : ''}` : '…'}
                </span>
              </Row>
            ) : null}
          </div>
        </div>

        {mode !== 'find' ? (
          <>
            <div className="tabs" role="tablist" aria-label="Business partner details">
              {(
                [
                  ['general', 'General'],
                  ['contacts', 'Contact Persons'],
                  ['addresses', 'Addresses'],
                  ['payment', 'Payment Terms'],
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
                    <Row label="Telephone">
                      <input className="grid-input" value={draft.phone} readOnly={!headerEditable} onChange={(e) => update('phone', e.target.value)} />
                    </Row>
                    <Row label="E-Mail" error={fields.email}>
                      <input className="grid-input" type="email" value={draft.email} readOnly={!headerEditable} onChange={(e) => update('email', e.target.value)} />
                    </Row>
                    <Row label="Web Site">
                      <input className="grid-input" value={draft.website} readOnly={!headerEditable} onChange={(e) => update('website', e.target.value)} />
                    </Row>
                  </div>
                  <div>
                    <Row label="Remarks">
                      <textarea className="grid-input grid-textarea" value={draft.remarks} readOnly={!headerEditable} onChange={(e) => update('remarks', e.target.value)} />
                    </Row>
                  </div>
                </div>
              ) : null}
              {tab === 'contacts' ? (
                <ContactsGrid
                  contacts={draft.contacts}
                  editable={headerEditable}
                  error={fields.contacts}
                  onChange={(contacts) => update('contacts', contacts)}
                />
              ) : null}
              {tab === 'addresses' ? (
                <AddressesGrid
                  addresses={draft.addresses}
                  editable={headerEditable}
                  error={fields.addresses}
                  onChange={(addresses) => update('addresses', addresses)}
                />
              ) : null}
              {tab === 'payment' ? (
                <div className="form-columns">
                  <div>
                    <Row label="Payment Terms" error={fields.paymentTermsId}>
                      <select
                        className="grid-input"
                        value={draft.paymentTermsId}
                        disabled={!headerEditable}
                        onChange={(e) => update('paymentTermsId', e.target.value)}
                      >
                        <option value="" />
                        {terms.map((term) => (
                          <option key={term.id} value={term.id}>
                            {term.name} ({term.dueDays} days)
                          </option>
                        ))}
                      </select>
                    </Row>
                    <Row label={`Credit Limit (${currency})`} error={fields.creditLimit}>
                      <input
                        className="grid-input grid-input--number"
                        inputMode="decimal"
                        value={draft.creditLimit}
                        readOnly={!headerEditable}
                        onChange={(e) => update('creditLimit', e.target.value)}
                        aria-invalid={fields.creditLimit ? true : undefined}
                      />
                    </Row>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </FormWindow>
      {choices ? (
        <ChooseFromList
          items={choices}
          onChoose={(id) => {
            setChoices(null);
            void loadById(id);
          }}
          onCancel={() => setChoices(null)}
        />
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

function ContactsGrid({
  contacts,
  editable,
  error,
  onChange,
}: {
  contacts: ContactDraft[];
  editable: boolean;
  error?: string;
  onChange: (contacts: ContactDraft[]) => void;
}) {
  const set = (key: string, patch: Partial<ContactDraft>) =>
    onChange(
      contacts.map((contact) =>
        contact.key === key ? { ...contact, ...patch } : patch.isDefault ? { ...contact, isDefault: false } : contact,
      ),
    );
  return (
    <>
      {error ? <Banner>{error}</Banner> : null}
      <DataTable
        rowNumbers
        rows={contacts}
        rowKey={(row) => row.key}
        empty="No contact persons."
        columns={[
          { key: 'name', header: 'Contact ID', render: (row) => <input className="grid-input" value={row.name} readOnly={!editable} onChange={(e) => set(row.key, { name: e.target.value })} /> },
          { key: 'position', header: 'Position', render: (row) => <input className="grid-input" value={row.position} readOnly={!editable} onChange={(e) => set(row.key, { position: e.target.value })} /> },
          { key: 'phone', header: 'Telephone', render: (row) => <input className="grid-input" value={row.phone} readOnly={!editable} onChange={(e) => set(row.key, { phone: e.target.value })} /> },
          { key: 'email', header: 'E-Mail', render: (row) => <input className="grid-input" value={row.email} readOnly={!editable} onChange={(e) => set(row.key, { email: e.target.value })} /> },
          {
            key: 'default',
            header: 'Default',
            render: (row) => <input type="checkbox" aria-label={`Default contact ${row.name}`} checked={row.isDefault} disabled={!editable} onChange={(e) => set(row.key, { isDefault: e.target.checked })} />,
          },
          {
            key: 'remove',
            header: '',
            render: (row) =>
              editable ? (
                <Button type="button" variant="ghost" aria-label={`Remove contact ${row.name}`} onClick={() => onChange(contacts.filter((contact) => contact.key !== row.key))}>
                  ×
                </Button>
              ) : null,
          },
        ]}
      />
      {editable ? (
        <p>
          <Button
            type="button"
            onClick={() => onChange([...contacts, { key: nextKey(), name: '', position: '', phone: '', email: '', isDefault: contacts.length === 0 }])}
          >
            Add Contact
          </Button>
        </p>
      ) : null}
    </>
  );
}

function AddressesGrid({
  addresses,
  editable,
  error,
  onChange,
}: {
  addresses: AddressDraft[];
  editable: boolean;
  error?: string;
  onChange: (addresses: AddressDraft[]) => void;
}) {
  const set = (key: string, patch: Partial<AddressDraft>) => {
    const target = addresses.find((address) => address.key === key);
    onChange(
      addresses.map((address) =>
        address.key === key
          ? { ...address, ...patch }
          : patch.isDefault && address.addressType === (patch.addressType ?? target?.addressType)
            ? { ...address, isDefault: false }
            : address,
      ),
    );
  };
  const add = (addressType: 'bill_to' | 'ship_to') =>
    onChange([
      ...addresses,
      {
        key: nextKey(),
        addressType,
        addressName: '',
        street: '',
        city: '',
        state: '',
        zipCode: '',
        country: '',
        isDefault: !addresses.some((address) => address.addressType === addressType),
      },
    ]);
  const text = (row: AddressDraft, field: keyof AddressDraft, width?: number) => (
    <input
      className="grid-input"
      style={width ? { width } : undefined}
      value={String(row[field])}
      readOnly={!editable}
      onChange={(e) => set(row.key, { [field]: e.target.value })}
    />
  );
  return (
    <>
      {error ? <Banner>{error}</Banner> : null}
      <DataTable
        rowNumbers
        rows={addresses}
        rowKey={(row) => row.key}
        empty="No addresses."
        columns={[
          {
            key: 'type',
            header: 'Type',
            render: (row) => (
              <select className="grid-input" value={row.addressType} disabled={!editable} onChange={(e) => set(row.key, { addressType: e.target.value as 'bill_to' | 'ship_to', isDefault: false })}>
                <option value="bill_to">Bill To</option>
                <option value="ship_to">Ship To</option>
              </select>
            ),
          },
          { key: 'name', header: 'Address ID', render: (row) => text(row, 'addressName') },
          { key: 'street', header: 'Street', render: (row) => text(row, 'street') },
          { key: 'city', header: 'City', render: (row) => text(row, 'city') },
          { key: 'state', header: 'State', render: (row) => text(row, 'state', 70) },
          { key: 'zip', header: 'Zip Code', render: (row) => text(row, 'zipCode', 70) },
          { key: 'country', header: 'Country', render: (row) => text(row, 'country', 40) },
          {
            key: 'default',
            header: 'Default',
            render: (row) => <input type="checkbox" aria-label={`Default address ${row.addressName}`} checked={row.isDefault} disabled={!editable} onChange={(e) => set(row.key, { isDefault: e.target.checked })} />,
          },
          {
            key: 'remove',
            header: '',
            render: (row) =>
              editable ? (
                <Button type="button" variant="ghost" aria-label={`Remove address ${row.addressName}`} onClick={() => onChange(addresses.filter((address) => address.key !== row.key))}>
                  ×
                </Button>
              ) : null,
          },
        ]}
      />
      {editable ? (
        <p className="pager">
          <Button type="button" onClick={() => add('bill_to')}>
            Add Bill To
          </Button>
          <Button type="button" onClick={() => add('ship_to')}>
            Add Ship To
          </Button>
          <span className="ui-muted">Country uses two-letter codes, for example PK or AE.</span>
        </p>
      ) : null}
    </>
  );
}

function ChooseFromList({ items, onChoose, onCancel }: { items: PartnerSummary[]; onChoose: (id: string) => void; onCancel: () => void }) {
  const [selected, setSelected] = useState(items[0]?.id ?? null);
  return (
    <div className="modal-backdrop" role="presentation">
      <FormWindow
        title="List of Business Partners"
        width={640}
        onClose={onCancel}
        footerLeft={
          <>
            <Button type="button" variant="primary" disabled={!selected} onClick={() => selected && onChoose(selected)}>
              Choose
            </Button>
            <Button type="button" onClick={onCancel}>
              Cancel
            </Button>
          </>
        }
      >
        <div className="ui-table-wrap">
          <table className="ui-table company-grid">
            <thead>
              <tr>
                <th scope="col" className="ui-table__row-number">#</th>
                <th scope="col">BP Code</th>
                <th scope="col">BP Name</th>
                <th scope="col">Type</th>
                <th scope="col">Group</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={item.id} aria-selected={item.id === selected} onClick={() => setSelected(item.id)} onDoubleClick={() => onChoose(item.id)}>
                  <td className="ui-table__row-number">{index + 1}</td>
                  <td>{item.code}</td>
                  <td>{item.name}</td>
                  <td>{TYPE_LABELS[item.partnerType]}</td>
                  <td>{item.groupName ?? ''}</td>
                  <td>
                    <StatusBadge status={item.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </FormWindow>
    </div>
  );
}
