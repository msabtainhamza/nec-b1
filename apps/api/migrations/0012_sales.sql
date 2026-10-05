CREATE TABLE sales_orders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  series_id uuid NOT NULL,
  number bigint NOT NULL,
  document_number text NOT NULL,
  customer_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  posting_date date NOT NULL,
  delivery_date date NOT NULL,
  customer_reference text,
  remarks text,
  currency char(3) NOT NULL,
  total numeric(19, 4) NOT NULL CHECK (total >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  closed_reason text CHECK (closed_reason IN ('fulfilled', 'manual')),
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, series_id, number),
  FOREIGN KEY (tenant_id, series_id) REFERENCES numbering_series (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES business_partners (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  CHECK ((status = 'closed') = (closed_reason IS NOT NULL)),
  CHECK (delivery_date >= posting_date)
);
CREATE INDEX sales_orders_customer_idx ON sales_orders (tenant_id, customer_id);

CREATE TABLE sales_order_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  item_id uuid NOT NULL,
  description text NOT NULL,
  uom_id uuid NOT NULL,
  stocked boolean NOT NULL,
  warehouse_id uuid,
  quantity numeric(19, 4) NOT NULL CHECK (quantity > 0),
  delivered_quantity numeric(19, 4) NOT NULL DEFAULT 0 CHECK (delivered_quantity >= 0),
  invoiced_quantity numeric(19, 4) NOT NULL DEFAULT 0 CHECK (invoiced_quantity >= 0),
  unit_price numeric(19, 4) NOT NULL CHECK (unit_price >= 0),
  discount_percent numeric(7, 4) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  net_price numeric(19, 4) NOT NULL CHECK (net_price >= 0),
  line_total numeric(19, 4) NOT NULL CHECK (line_total >= 0),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, order_id, line_no),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id),
  FOREIGN KEY (tenant_id, uom_id) REFERENCES units_of_measure (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  CHECK (stocked = (warehouse_id IS NOT NULL)),
  CHECK (delivered_quantity <= quantity),
  CHECK (invoiced_quantity <= quantity),
  CHECK (stocked OR delivered_quantity = 0)
);
CREATE INDEX sales_order_lines_item_idx ON sales_order_lines (tenant_id, item_id);

CREATE TABLE deliveries (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  series_id uuid NOT NULL,
  number bigint NOT NULL,
  document_number text NOT NULL,
  order_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  posting_date date NOT NULL,
  remarks text,
  currency char(3) NOT NULL,
  total numeric(19, 4) NOT NULL CHECK (total >= 0),
  cost_total numeric(19, 4) NOT NULL CHECK (cost_total >= 0),
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
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES business_partners (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, cancellation_of_id) REFERENCES deliveries (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES journal_entries (tenant_id, id),
  CHECK (is_cancellation = (cancellation_of_id IS NOT NULL)),
  CHECK (is_cancellation = (cancellation_reason IS NOT NULL)),
  CHECK (NOT (is_cancellation AND status = 'cancelled')),
  CHECK (cost_total = 0 OR journal_id IS NOT NULL)
);
CREATE UNIQUE INDEX deliveries_single_cancellation_key ON deliveries (tenant_id, cancellation_of_id) WHERE cancellation_of_id IS NOT NULL;
CREATE INDEX deliveries_order_idx ON deliveries (tenant_id, order_id);

CREATE TABLE delivery_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  order_line_id uuid NOT NULL,
  item_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  quantity numeric(19, 4) NOT NULL CHECK (quantity > 0),
  net_price numeric(19, 4) NOT NULL CHECK (net_price >= 0),
  line_total numeric(19, 4) NOT NULL CHECK (line_total >= 0),
  cost_value numeric(19, 4) NOT NULL CHECK (cost_value >= 0),
  invoiced_quantity numeric(19, 4) NOT NULL DEFAULT 0 CHECK (invoiced_quantity >= 0),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, delivery_id, line_no),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES deliveries (tenant_id, id),
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES sales_order_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  CHECK (invoiced_quantity <= quantity)
);

CREATE TABLE ar_invoices (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  series_id uuid NOT NULL,
  number bigint NOT NULL,
  document_number text NOT NULL,
  customer_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  posting_date date NOT NULL,
  document_date date NOT NULL,
  due_date date NOT NULL,
  customer_reference text,
  remarks text,
  currency char(3) NOT NULL,
  subtotal numeric(19, 4) NOT NULL CHECK (subtotal >= 0),
  tax_total numeric(19, 4) NOT NULL CHECK (tax_total >= 0),
  total numeric(19, 4) NOT NULL CHECK (total >= 0),
  paid_amount numeric(19, 4) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
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
  FOREIGN KEY (tenant_id, customer_id) REFERENCES business_partners (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, cancellation_of_id) REFERENCES ar_invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES journal_entries (tenant_id, id),
  CHECK (is_cancellation = (cancellation_of_id IS NOT NULL)),
  CHECK (is_cancellation = (cancellation_reason IS NOT NULL)),
  CHECK (NOT (is_cancellation AND status = 'cancelled')),
  CHECK (paid_amount <= total),
  CHECK (total = subtotal + tax_total),
  CHECK (due_date >= document_date),
  CHECK (total = 0 OR journal_id IS NOT NULL)
);
CREATE UNIQUE INDEX ar_invoices_single_cancellation_key ON ar_invoices (tenant_id, cancellation_of_id) WHERE cancellation_of_id IS NOT NULL;
CREATE INDEX ar_invoices_customer_idx ON ar_invoices (tenant_id, customer_id);

CREATE TABLE ar_invoice_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  line_kind text NOT NULL CHECK (line_kind IN ('delivery', 'order')),
  delivery_id uuid,
  delivery_line_id uuid,
  order_line_id uuid NOT NULL,
  item_id uuid NOT NULL,
  description text NOT NULL,
  quantity numeric(19, 4) NOT NULL CHECK (quantity > 0),
  unit_price numeric(19, 4) NOT NULL CHECK (unit_price >= 0),
  line_total numeric(19, 4) NOT NULL CHECK (line_total >= 0),
  revenue_account_id uuid NOT NULL,
  tax_code_id uuid,
  tax_rate numeric(7, 4) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0),
  tax_amount numeric(19, 4) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, invoice_id, line_no),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES ar_invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES deliveries (tenant_id, id),
  FOREIGN KEY (tenant_id, delivery_line_id) REFERENCES delivery_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES sales_order_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id),
  FOREIGN KEY (tenant_id, revenue_account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, tax_code_id) REFERENCES tax_codes (tenant_id, id),
  CHECK ((line_kind = 'delivery') = (delivery_line_id IS NOT NULL)),
  CHECK ((delivery_id IS NULL) = (delivery_line_id IS NULL))
);
CREATE INDEX ar_invoice_lines_delivery_idx ON ar_invoice_lines (tenant_id, delivery_line_id) WHERE delivery_line_id IS NOT NULL;

ALTER TABLE payment_allocations ADD COLUMN ar_invoice_id uuid;
ALTER TABLE payment_allocations ADD FOREIGN KEY (tenant_id, ar_invoice_id) REFERENCES ar_invoices (tenant_id, id);
ALTER TABLE payment_allocations DROP CONSTRAINT payment_allocations_single_target;
ALTER TABLE payment_allocations ADD CONSTRAINT payment_allocations_single_target CHECK (num_nonnulls(invoice_id, opening_line_id, ar_invoice_id) = 1);
CREATE INDEX payment_allocations_ar_invoice_idx ON payment_allocations (tenant_id, ar_invoice_id) WHERE ar_invoice_id IS NOT NULL;

CREATE OR REPLACE FUNCTION seed_sales_defaults(target_tenant uuid) RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO numbering_series (tenant_id, document_type, name, prefix, next_number, is_default)
  VALUES (target_tenant, 'sales_order', 'Primary', 'SO', 1, true),
         (target_tenant, 'delivery', 'Primary', 'DN', 1, true),
         (target_tenant, 'ar_invoice', 'Primary', 'IN', 1, true)
  ON CONFLICT DO NOTHING;
$$;

ALTER TABLE numbering_series NO FORCE ROW LEVEL SECURITY;
SELECT seed_sales_defaults(id) FROM tenants;
ALTER TABLE numbering_series FORCE ROW LEVEL SECURITY;

ALTER TABLE sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY sales_orders_tenant ON sales_orders
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE sales_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY sales_order_lines_tenant ON sales_order_lines
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY deliveries_tenant ON deliveries
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE delivery_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_lines_tenant ON delivery_lines
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE ar_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE ar_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY ar_invoices_tenant ON ar_invoices
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE ar_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE ar_invoice_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY ar_invoice_lines_tenant ON ar_invoice_lines
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON sales_orders TO {{app_role}};
GRANT SELECT, INSERT ON sales_order_lines TO {{app_role}};
GRANT UPDATE (delivered_quantity, invoiced_quantity) ON sales_order_lines TO {{app_role}};
GRANT SELECT, INSERT ON deliveries TO {{app_role}};
GRANT UPDATE (status) ON deliveries TO {{app_role}};
GRANT SELECT, INSERT ON delivery_lines TO {{app_role}};
GRANT UPDATE (invoiced_quantity) ON delivery_lines TO {{app_role}};
GRANT SELECT, INSERT ON ar_invoices TO {{app_role}};
GRANT UPDATE (status, paid_amount) ON ar_invoices TO {{app_role}};
GRANT SELECT, INSERT ON ar_invoice_lines TO {{app_role}};
GRANT EXECUTE ON FUNCTION seed_sales_defaults(uuid) TO {{app_role}};

UPDATE plans SET modules = array_append(modules, 'sal') WHERE NOT ('sal' = ANY (modules));
UPDATE tenant_entitlements SET modules = array_append(modules, 'sal'), updated_at = now() WHERE NOT ('sal' = ANY (modules));

ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO roles (tenant_id, code, name, is_system)
SELECT t.id, 'sales', 'Salesperson', true FROM tenants t
ON CONFLICT (tenant_id, code) DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES
  ('sal.order.view'), ('sal.order.create'), ('sal.order.edit'), ('sal.delivery.view'), ('sal.delivery.post'), ('sal.delivery.cancel'),
  ('sal.invoice.view'), ('sal.invoice.post'), ('sal.invoice.cancel')
) AS p (permission)
WHERE r.is_system AND r.code IN ('owner', 'administrator')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES ('sal.order.view'), ('sal.delivery.view'), ('sal.invoice.view'), ('sal.invoice.post'), ('sal.invoice.cancel')) AS p (permission)
WHERE r.is_system AND r.code = 'accountant'
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES ('sal.order.view'), ('sal.delivery.view'), ('sal.invoice.view')) AS p (permission)
WHERE r.is_system AND r.code = 'auditor'
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES ('sal.order.view'), ('sal.delivery.view'), ('sal.delivery.post'), ('sal.delivery.cancel')) AS p (permission)
WHERE r.is_system AND r.code = 'warehouse'
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES
  ('sal.order.view'), ('sal.order.create'), ('sal.order.edit'), ('sal.delivery.view'), ('sal.invoice.view'),
  ('bp.partner.view'), ('bp.partner.create'), ('bp.partner.edit'), ('inv.item.view'), ('inv.price.view'), ('inv.stock.view'), ('admin.branch.view')
) AS p (permission)
WHERE r.is_system AND r.code = 'sales'
ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
