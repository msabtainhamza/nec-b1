CREATE TABLE outgoing_payments (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  series_id uuid NOT NULL,
  number bigint NOT NULL,
  document_number text NOT NULL,
  vendor_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  posting_date date NOT NULL,
  document_date date NOT NULL,
  payment_means text NOT NULL CHECK (payment_means IN ('cash', 'bank_transfer', 'cheque')),
  account_id uuid NOT NULL,
  reference text,
  remarks text,
  currency char(3) NOT NULL,
  amount numeric(19, 4) NOT NULL CHECK (amount > 0),
  allocated_amount numeric(19, 4) NOT NULL DEFAULT 0 CHECK (allocated_amount >= 0),
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'cancelled')),
  is_cancellation boolean NOT NULL DEFAULT false,
  cancellation_of_id uuid,
  cancellation_reason text,
  journal_id uuid NOT NULL,
  created_by uuid REFERENCES users (id),
  posted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, series_id, number),
  FOREIGN KEY (tenant_id, series_id) REFERENCES numbering_series (tenant_id, id),
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES business_partners (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, cancellation_of_id) REFERENCES outgoing_payments (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES journal_entries (tenant_id, id),
  CHECK (is_cancellation = (cancellation_of_id IS NOT NULL)),
  CHECK (is_cancellation = (cancellation_reason IS NOT NULL)),
  CHECK (NOT (is_cancellation AND status = 'cancelled')),
  CHECK (NOT is_cancellation OR allocated_amount = 0),
  CHECK (allocated_amount <= amount)
);
CREATE UNIQUE INDEX outgoing_payments_single_cancellation_key ON outgoing_payments (tenant_id, cancellation_of_id) WHERE cancellation_of_id IS NOT NULL;
CREATE INDEX outgoing_payments_vendor_idx ON outgoing_payments (tenant_id, vendor_id);

CREATE TABLE payment_allocations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  event_type text NOT NULL CHECK (event_type IN ('allocate', 'unallocate')),
  payment_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount numeric(19, 4) NOT NULL CHECK (amount > 0),
  event_date date NOT NULL,
  reverses_id uuid,
  reason text,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES outgoing_payments (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES ap_invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, reverses_id) REFERENCES payment_allocations (tenant_id, id),
  CHECK ((event_type = 'unallocate') = (reverses_id IS NOT NULL)),
  CHECK ((event_type = 'unallocate') = (reason IS NOT NULL))
);
CREATE UNIQUE INDEX payment_allocations_single_unallocation_key ON payment_allocations (tenant_id, reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX payment_allocations_payment_idx ON payment_allocations (tenant_id, payment_id);
CREATE INDEX payment_allocations_invoice_idx ON payment_allocations (tenant_id, invoice_id);

CREATE OR REPLACE FUNCTION payment_allocations_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'payment allocation events are append-only';
END
$$;
CREATE TRIGGER payment_allocations_no_update BEFORE UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION payment_allocations_immutable();

CREATE OR REPLACE FUNCTION seed_banking_defaults(target_tenant uuid) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO numbering_series (tenant_id, document_type, name, prefix, next_number, is_default)
  VALUES (target_tenant, 'outgoing_payment', 'Primary', 'OP', 1, true)
  ON CONFLICT DO NOTHING;
END
$$;

ALTER TABLE numbering_series NO FORCE ROW LEVEL SECURITY;
SELECT seed_banking_defaults(id) FROM tenants;
ALTER TABLE numbering_series FORCE ROW LEVEL SECURITY;

ALTER TABLE outgoing_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE outgoing_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY outgoing_payments_tenant ON outgoing_payments
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_allocations_select ON payment_allocations FOR SELECT USING (tenant_id = app_current_tenant_id());
CREATE POLICY payment_allocations_insert ON payment_allocations FOR INSERT WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT ON outgoing_payments TO {{app_role}};
GRANT UPDATE (status, allocated_amount) ON outgoing_payments TO {{app_role}};
GRANT SELECT, INSERT ON payment_allocations TO {{app_role}};
GRANT UPDATE (paid_amount) ON ap_invoices TO {{app_role}};
GRANT EXECUTE ON FUNCTION seed_banking_defaults(uuid) TO {{app_role}};

ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES ('bank.payment.view'), ('bank.payment.post'), ('bank.payment.cancel'), ('bank.payment.unallocate')) AS p (permission)
WHERE r.is_system AND r.code IN ('owner', 'administrator', 'accountant')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, 'bank.payment.view'
FROM roles r
WHERE r.is_system AND r.code = 'auditor'
ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

UPDATE plans SET modules = array_append(modules, 'bank') WHERE NOT ('bank' = ANY (modules));
UPDATE tenant_entitlements SET modules = array_append(modules, 'bank'), updated_at = now() WHERE NOT ('bank' = ANY (modules));
