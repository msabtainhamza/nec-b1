CREATE TABLE opening_balances (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  series_id uuid NOT NULL,
  number bigint NOT NULL,
  document_number text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('account', 'partner')),
  posting_date date NOT NULL,
  offset_account_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) > 0),
  remarks text,
  total_debit numeric(19, 4) NOT NULL CHECK (total_debit >= 0),
  total_credit numeric(19, 4) NOT NULL CHECK (total_credit >= 0),
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
  FOREIGN KEY (tenant_id, offset_account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, cancellation_of_id) REFERENCES opening_balances (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES journal_entries (tenant_id, id),
  CHECK (is_cancellation = (cancellation_of_id IS NOT NULL)),
  CHECK (is_cancellation = (cancellation_reason IS NOT NULL)),
  CHECK (NOT (is_cancellation AND status = 'cancelled'))
);
CREATE UNIQUE INDEX opening_balances_single_cancellation_key ON opening_balances (tenant_id, cancellation_of_id) WHERE cancellation_of_id IS NOT NULL;

CREATE TABLE opening_balance_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  opening_balance_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  account_id uuid,
  partner_id uuid,
  reference text,
  document_date date,
  due_date date,
  debit numeric(19, 4) NOT NULL CHECK (debit >= 0),
  credit numeric(19, 4) NOT NULL CHECK (credit >= 0),
  paid_amount numeric(19, 4) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, opening_balance_id, line_no),
  FOREIGN KEY (tenant_id, opening_balance_id) REFERENCES opening_balances (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, partner_id) REFERENCES business_partners (tenant_id, id),
  CHECK ((account_id IS NULL) <> (partner_id IS NULL)),
  CHECK ((debit > 0) <> (credit > 0)),
  CHECK (partner_id IS NOT NULL OR (document_date IS NULL AND due_date IS NULL AND paid_amount = 0)),
  CHECK (partner_id IS NULL OR (document_date IS NOT NULL AND due_date IS NOT NULL AND due_date >= document_date)),
  CHECK (paid_amount <= debit + credit)
);
CREATE INDEX opening_balance_lines_partner_idx ON opening_balance_lines (tenant_id, partner_id) WHERE partner_id IS NOT NULL;

ALTER TABLE payment_allocations ALTER COLUMN invoice_id DROP NOT NULL;
ALTER TABLE payment_allocations ADD COLUMN opening_line_id uuid;
ALTER TABLE payment_allocations ADD FOREIGN KEY (tenant_id, opening_line_id) REFERENCES opening_balance_lines (tenant_id, id);
ALTER TABLE payment_allocations ADD CONSTRAINT payment_allocations_single_target CHECK ((invoice_id IS NULL) <> (opening_line_id IS NULL));
CREATE INDEX payment_allocations_opening_line_idx ON payment_allocations (tenant_id, opening_line_id) WHERE opening_line_id IS NOT NULL;

ALTER TABLE inventory_adjustments DROP CONSTRAINT inventory_adjustments_direction_check;
ALTER TABLE inventory_adjustments ADD CONSTRAINT inventory_adjustments_direction_check CHECK (direction IN ('receipt', 'issue', 'opening'));

CREATE OR REPLACE FUNCTION seed_opening_balance_defaults(target_tenant uuid) RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO numbering_series (tenant_id, document_type, name, prefix, next_number, is_default)
  VALUES (target_tenant, 'opening_balance', 'Primary', 'OB', 1, true),
         (target_tenant, 'stock_opening', 'Primary', 'IO', 1, true)
  ON CONFLICT DO NOTHING;
$$;

ALTER TABLE numbering_series NO FORCE ROW LEVEL SECURITY;
SELECT seed_opening_balance_defaults(id) FROM tenants;
ALTER TABLE numbering_series FORCE ROW LEVEL SECURITY;

ALTER TABLE opening_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE opening_balances FORCE ROW LEVEL SECURITY;
CREATE POLICY opening_balances_tenant ON opening_balances
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE opening_balance_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE opening_balance_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY opening_balance_lines_tenant ON opening_balance_lines
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT ON opening_balances TO {{app_role}};
GRANT UPDATE (status) ON opening_balances TO {{app_role}};
GRANT SELECT, INSERT ON opening_balance_lines TO {{app_role}};
GRANT UPDATE (paid_amount) ON opening_balance_lines TO {{app_role}};
GRANT EXECUTE ON FUNCTION seed_opening_balance_defaults(uuid) TO {{app_role}};

ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES ('fin.opening.post'), ('fin.opening.cancel'), ('inv.opening.post'), ('inv.opening.cancel')) AS p (permission)
WHERE r.is_system AND r.code IN ('owner', 'administrator', 'accountant')
ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
