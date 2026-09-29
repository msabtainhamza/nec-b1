CREATE TABLE purchasing_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  price_tolerance_percent numeric(7, 4) NOT NULL DEFAULT 0 CHECK (price_tolerance_percent >= 0 AND price_tolerance_percent <= 100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE ap_invoices (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  series_id uuid NOT NULL,
  number bigint NOT NULL,
  document_number text NOT NULL,
  vendor_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  posting_date date NOT NULL,
  document_date date NOT NULL,
  due_date date NOT NULL,
  vendor_reference text,
  remarks text,
  currency char(3) NOT NULL,
  total numeric(19, 4) NOT NULL CHECK (total >= 0),
  paid_amount numeric(19, 4) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'cancelled')),
  is_cancellation boolean NOT NULL DEFAULT false,
  cancellation_of_id uuid,
  cancellation_reason text,
  price_override boolean NOT NULL DEFAULT false,
  journal_id uuid,
  created_by uuid REFERENCES users (id),
  posted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, series_id, number),
  FOREIGN KEY (tenant_id, series_id) REFERENCES numbering_series (tenant_id, id),
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES business_partners (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, cancellation_of_id) REFERENCES ap_invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES journal_entries (tenant_id, id),
  CHECK (is_cancellation = (cancellation_of_id IS NOT NULL)),
  CHECK (is_cancellation = (cancellation_reason IS NOT NULL)),
  CHECK (NOT (is_cancellation AND status = 'cancelled')),
  CHECK (paid_amount <= total),
  CHECK (due_date >= document_date)
);
CREATE UNIQUE INDEX ap_invoices_single_cancellation_key ON ap_invoices (tenant_id, cancellation_of_id) WHERE cancellation_of_id IS NOT NULL;
CREATE UNIQUE INDEX ap_invoices_vendor_reference_key ON ap_invoices (tenant_id, vendor_id, lower(vendor_reference))
  WHERE vendor_reference IS NOT NULL AND NOT is_cancellation AND status = 'posted';
CREATE INDEX ap_invoices_vendor_idx ON ap_invoices (tenant_id, vendor_id);

CREATE TABLE ap_invoice_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  receipt_id uuid NOT NULL,
  receipt_line_id uuid NOT NULL,
  order_line_id uuid NOT NULL,
  item_id uuid NOT NULL,
  description text NOT NULL,
  stocked boolean NOT NULL,
  quantity numeric(19, 4) NOT NULL CHECK (quantity > 0),
  receipt_price numeric(19, 4) NOT NULL CHECK (receipt_price >= 0),
  unit_price numeric(19, 4) NOT NULL CHECK (unit_price >= 0),
  line_total numeric(19, 4) NOT NULL CHECK (line_total >= 0),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, invoice_id, line_no),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES ap_invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES goods_receipts (tenant_id, id),
  FOREIGN KEY (tenant_id, receipt_line_id) REFERENCES goods_receipt_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES purchase_order_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id)
);
CREATE INDEX ap_invoice_lines_receipt_idx ON ap_invoice_lines (tenant_id, receipt_line_id);

CREATE OR REPLACE FUNCTION seed_ap_defaults(target_tenant uuid) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  expense_title uuid;
  expense_account uuid;
BEGIN
  INSERT INTO purchasing_settings (tenant_id) VALUES (target_tenant) ON CONFLICT DO NOTHING;

  INSERT INTO numbering_series (tenant_id, document_type, name, prefix, next_number, is_default)
  VALUES (target_tenant, 'ap_invoice', 'Primary', 'AP', 1, true)
  ON CONFLICT DO NOTHING;

  SELECT id INTO expense_title FROM accounts WHERE tenant_id = target_tenant AND code = '5' AND is_title;
  IF expense_title IS NOT NULL THEN
    INSERT INTO accounts (tenant_id, code, name, account_type, parent_id)
    VALUES (target_tenant, '5400', 'Purchased Services and Supplies', 'expense', expense_title)
    ON CONFLICT (tenant_id, code) DO NOTHING;
  END IF;
  SELECT id INTO expense_account FROM accounts WHERE tenant_id = target_tenant AND code = '5400' AND NOT is_title AND account_type = 'expense';
  IF expense_account IS NOT NULL THEN
    INSERT INTO gl_determination (tenant_id, determination_key, account_id)
    VALUES (target_tenant, 'purchase_expense', expense_account)
    ON CONFLICT DO NOTHING;
  END IF;
END
$$;

ALTER TABLE numbering_series NO FORCE ROW LEVEL SECURITY;
ALTER TABLE accounts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE gl_determination NO FORCE ROW LEVEL SECURITY;
SELECT seed_ap_defaults(id) FROM tenants;
ALTER TABLE numbering_series FORCE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE gl_determination FORCE ROW LEVEL SECURITY;

ALTER TABLE purchasing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchasing_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY purchasing_settings_tenant ON purchasing_settings
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE ap_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY ap_invoices_tenant ON ap_invoices
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE ap_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_invoice_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY ap_invoice_lines_tenant ON ap_invoice_lines
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON purchasing_settings TO {{app_role}};
GRANT SELECT, INSERT ON ap_invoices TO {{app_role}};
GRANT UPDATE (status) ON ap_invoices TO {{app_role}};
GRANT SELECT, INSERT ON ap_invoice_lines TO {{app_role}};
GRANT UPDATE (invoiced_quantity) ON goods_receipt_lines TO {{app_role}};
GRANT EXECUTE ON FUNCTION seed_ap_defaults(uuid) TO {{app_role}};

ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES ('pur.invoice.view'), ('pur.invoice.post'), ('pur.invoice.cancel'), ('pur.invoice.override'), ('pur.setup.administer')) AS p (permission)
WHERE r.is_system AND r.code IN ('owner', 'administrator')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES ('pur.invoice.view'), ('pur.invoice.post'), ('pur.invoice.cancel')) AS p (permission)
WHERE r.is_system AND r.code = 'accountant'
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, 'pur.invoice.view'
FROM roles r
WHERE r.is_system AND r.code IN ('auditor', 'buyer')
ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
