CREATE TABLE stock_transfers (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  series_id uuid NOT NULL,
  number bigint NOT NULL,
  document_number text NOT NULL,
  from_warehouse_id uuid NOT NULL,
  to_warehouse_id uuid NOT NULL,
  posting_date date NOT NULL,
  reason text NOT NULL CHECK (length(reason) > 0),
  remarks text,
  total_value numeric(19, 4) NOT NULL CHECK (total_value >= 0),
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'cancelled')),
  is_cancellation boolean NOT NULL DEFAULT false,
  cancellation_of_id uuid,
  cancellation_reason text,
  journal_id uuid,
  created_by uuid REFERENCES users (id),
  posted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, series_id, number),
  FOREIGN KEY (tenant_id, series_id) REFERENCES numbering_series (tenant_id, id),
  FOREIGN KEY (tenant_id, from_warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, to_warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, cancellation_of_id) REFERENCES stock_transfers (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES journal_entries (tenant_id, id),
  CHECK (from_warehouse_id <> to_warehouse_id),
  CHECK (is_cancellation = (cancellation_of_id IS NOT NULL)),
  CHECK (is_cancellation = (cancellation_reason IS NOT NULL)),
  CHECK (NOT (is_cancellation AND status = 'cancelled'))
);
CREATE UNIQUE INDEX stock_transfers_single_cancellation_key ON stock_transfers (tenant_id, cancellation_of_id) WHERE cancellation_of_id IS NOT NULL;

CREATE TABLE stock_transfer_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  transfer_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  item_id uuid NOT NULL,
  quantity numeric(19, 4) NOT NULL CHECK (quantity > 0),
  value numeric(19, 4) NOT NULL CHECK (value >= 0),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, transfer_id, line_no),
  FOREIGN KEY (tenant_id, transfer_id) REFERENCES stock_transfers (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id)
);

CREATE TABLE inventory_adjustments (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  series_id uuid NOT NULL,
  number bigint NOT NULL,
  document_number text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('receipt', 'issue')),
  posting_date date NOT NULL,
  offset_account_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) > 0),
  remarks text,
  total_value numeric(19, 4) NOT NULL CHECK (total_value >= 0),
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'cancelled')),
  is_cancellation boolean NOT NULL DEFAULT false,
  cancellation_of_id uuid,
  cancellation_reason text,
  journal_id uuid,
  created_by uuid REFERENCES users (id),
  posted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, series_id, number),
  FOREIGN KEY (tenant_id, series_id) REFERENCES numbering_series (tenant_id, id),
  FOREIGN KEY (tenant_id, offset_account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, cancellation_of_id) REFERENCES inventory_adjustments (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES journal_entries (tenant_id, id),
  CHECK (is_cancellation = (cancellation_of_id IS NOT NULL)),
  CHECK (is_cancellation = (cancellation_reason IS NOT NULL)),
  CHECK (NOT (is_cancellation AND status = 'cancelled')),
  CHECK (total_value = 0 OR journal_id IS NOT NULL)
);
CREATE UNIQUE INDEX inventory_adjustments_single_cancellation_key ON inventory_adjustments (tenant_id, cancellation_of_id) WHERE cancellation_of_id IS NOT NULL;

CREATE TABLE inventory_adjustment_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  adjustment_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  item_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  inventory_account_id uuid NOT NULL,
  quantity numeric(19, 4) NOT NULL CHECK (quantity > 0),
  unit_cost numeric(19, 6) NOT NULL CHECK (unit_cost >= 0),
  value numeric(19, 4) NOT NULL CHECK (value >= 0),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, adjustment_id, line_no),
  FOREIGN KEY (tenant_id, adjustment_id) REFERENCES inventory_adjustments (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, inventory_account_id) REFERENCES accounts (tenant_id, id)
);

CREATE OR REPLACE FUNCTION seed_stock_transaction_defaults(target_tenant uuid) RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO numbering_series (tenant_id, document_type, name, prefix, next_number, is_default)
  VALUES (target_tenant, 'stock_transfer', 'Primary', 'ST', 1, true),
         (target_tenant, 'stock_receipt', 'Primary', 'SR', 1, true),
         (target_tenant, 'stock_issue', 'Primary', 'SI', 1, true)
  ON CONFLICT DO NOTHING;
$$;

ALTER TABLE numbering_series NO FORCE ROW LEVEL SECURITY;
SELECT seed_stock_transaction_defaults(id) FROM tenants;
ALTER TABLE numbering_series FORCE ROW LEVEL SECURITY;

ALTER TABLE stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_transfers_tenant ON stock_transfers
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE stock_transfer_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfer_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_transfer_lines_tenant ON stock_transfer_lines
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE inventory_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_adjustments_tenant ON inventory_adjustments
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE inventory_adjustment_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_adjustment_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_adjustment_lines_tenant ON inventory_adjustment_lines
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT ON stock_transfers TO {{app_role}};
GRANT UPDATE (status) ON stock_transfers TO {{app_role}};
GRANT SELECT, INSERT ON stock_transfer_lines TO {{app_role}};
GRANT SELECT, INSERT ON inventory_adjustments TO {{app_role}};
GRANT UPDATE (status) ON inventory_adjustments TO {{app_role}};
GRANT SELECT, INSERT ON inventory_adjustment_lines TO {{app_role}};
GRANT EXECUTE ON FUNCTION seed_stock_transaction_defaults(uuid) TO {{app_role}};

ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES ('inv.transfer.post'), ('inv.transfer.cancel'), ('inv.adjustment.post'), ('inv.adjustment.cancel')) AS p (permission)
WHERE r.is_system AND r.code IN ('owner', 'administrator')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES ('inv.adjustment.post'), ('inv.adjustment.cancel')) AS p (permission)
WHERE r.is_system AND r.code = 'accountant'
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES ('inv.transfer.post'), ('inv.transfer.cancel')) AS p (permission)
WHERE r.is_system AND r.code = 'warehouse'
ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
