CREATE TABLE purchase_orders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  series_id uuid NOT NULL,
  number bigint NOT NULL,
  document_number text NOT NULL,
  vendor_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  posting_date date NOT NULL,
  delivery_date date NOT NULL,
  vendor_reference text,
  remarks text,
  currency char(3) NOT NULL,
  total numeric(19, 4) NOT NULL CHECK (total >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  closed_reason text CHECK (closed_reason IN ('fully_received', 'manual')),
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, series_id, number),
  FOREIGN KEY (tenant_id, series_id) REFERENCES numbering_series (tenant_id, id),
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES business_partners (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  CHECK ((status = 'closed') = (closed_reason IS NOT NULL))
);
CREATE INDEX purchase_orders_vendor_idx ON purchase_orders (tenant_id, vendor_id);

CREATE TABLE purchase_order_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  item_id uuid NOT NULL,
  description text NOT NULL,
  uom_id uuid NOT NULL,
  warehouse_id uuid,
  quantity numeric(19, 4) NOT NULL CHECK (quantity > 0),
  received_quantity numeric(19, 4) NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  unit_price numeric(19, 4) NOT NULL CHECK (unit_price >= 0),
  discount_percent numeric(7, 4) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  net_price numeric(19, 4) NOT NULL CHECK (net_price >= 0),
  line_total numeric(19, 4) NOT NULL CHECK (line_total >= 0),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, order_id, line_no),
  FOREIGN KEY (tenant_id, order_id) REFERENCES purchase_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id),
  FOREIGN KEY (tenant_id, uom_id) REFERENCES units_of_measure (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  CHECK (received_quantity <= quantity)
);
CREATE INDEX purchase_order_lines_item_idx ON purchase_order_lines (tenant_id, item_id);

CREATE TABLE goods_receipts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  series_id uuid NOT NULL,
  number bigint NOT NULL,
  document_number text NOT NULL,
  order_id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  posting_date date NOT NULL,
  remarks text,
  currency char(3) NOT NULL,
  total numeric(19, 4) NOT NULL CHECK (total >= 0),
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
  FOREIGN KEY (tenant_id, order_id) REFERENCES purchase_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES business_partners (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, cancellation_of_id) REFERENCES goods_receipts (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES journal_entries (tenant_id, id),
  CHECK (is_cancellation = (cancellation_of_id IS NOT NULL)),
  CHECK (is_cancellation = (cancellation_reason IS NOT NULL)),
  CHECK (NOT (is_cancellation AND status = 'cancelled'))
);
CREATE UNIQUE INDEX goods_receipts_single_cancellation_key ON goods_receipts (tenant_id, cancellation_of_id) WHERE cancellation_of_id IS NOT NULL;
CREATE INDEX goods_receipts_order_idx ON goods_receipts (tenant_id, order_id);

CREATE TABLE goods_receipt_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  order_line_id uuid NOT NULL,
  item_id uuid NOT NULL,
  warehouse_id uuid,
  quantity numeric(19, 4) NOT NULL CHECK (quantity > 0),
  net_price numeric(19, 4) NOT NULL CHECK (net_price >= 0),
  line_total numeric(19, 4) NOT NULL CHECK (line_total >= 0),
  invoiced_quantity numeric(19, 4) NOT NULL DEFAULT 0 CHECK (invoiced_quantity >= 0),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, receipt_id, line_no),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES goods_receipts (tenant_id, id),
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES purchase_order_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  CHECK (invoiced_quantity <= quantity)
);

CREATE TABLE stock_movements (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  item_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  quantity numeric(19, 4) NOT NULL CHECK (quantity <> 0),
  value numeric(19, 4) NOT NULL,
  unit_cost numeric(19, 6) NOT NULL CHECK (unit_cost >= 0),
  source_type text NOT NULL CHECK (source_type ~ '^[a-z_]{2,40}$'),
  source_id uuid NOT NULL,
  source_line_id uuid,
  posting_date date NOT NULL,
  journal_id uuid,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES journal_entries (tenant_id, id)
);
CREATE INDEX stock_movements_item_idx ON stock_movements (tenant_id, item_id, created_at);
CREATE INDEX stock_movements_source_idx ON stock_movements (tenant_id, source_type, source_id);
CREATE TRIGGER stock_movements_immutable
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

CREATE TABLE item_valuations (
  tenant_id uuid NOT NULL,
  item_id uuid NOT NULL,
  on_hand numeric(19, 4) NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  total_value numeric(19, 4) NOT NULL DEFAULT 0 CHECK (total_value >= 0),
  average_cost numeric(19, 6) NOT NULL DEFAULT 0 CHECK (average_cost >= 0),
  last_movement_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id),
  FOREIGN KEY (tenant_id, last_movement_id) REFERENCES stock_movements (tenant_id, id),
  CHECK (on_hand > 0 OR total_value = 0)
);

CREATE TABLE item_warehouse_stock (
  tenant_id uuid NOT NULL,
  item_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  on_hand numeric(19, 4) NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id, warehouse_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id)
);

CREATE FUNCTION seed_purchasing_defaults(target_tenant uuid) RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO numbering_series (tenant_id, document_type, name, prefix, next_number, is_default)
  VALUES (target_tenant, 'purchase_order', 'Primary', 'PO', 1, true),
         (target_tenant, 'goods_receipt', 'Primary', 'GR', 1, true)
  ON CONFLICT DO NOTHING;
$$;

ALTER TABLE numbering_series NO FORCE ROW LEVEL SECURITY;
SELECT seed_purchasing_defaults(id) FROM tenants;
ALTER TABLE numbering_series FORCE ROW LEVEL SECURITY;

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_orders_tenant ON purchase_orders
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_order_lines_tenant ON purchase_order_lines
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE goods_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY goods_receipts_tenant ON goods_receipts
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE goods_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY goods_receipt_lines_tenant ON goods_receipt_lines
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_movements_select ON stock_movements FOR SELECT USING (tenant_id = app_current_tenant_id());
CREATE POLICY stock_movements_insert ON stock_movements FOR INSERT WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE item_valuations ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_valuations FORCE ROW LEVEL SECURITY;
CREATE POLICY item_valuations_tenant ON item_valuations
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE item_warehouse_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_warehouse_stock FORCE ROW LEVEL SECURITY;
CREATE POLICY item_warehouse_stock_tenant ON item_warehouse_stock
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON purchase_orders TO {{app_role}};
GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_order_lines TO {{app_role}};
GRANT SELECT, INSERT ON goods_receipts TO {{app_role}};
GRANT UPDATE (status) ON goods_receipts TO {{app_role}};
GRANT SELECT, INSERT ON goods_receipt_lines TO {{app_role}};
GRANT SELECT, INSERT ON stock_movements TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON item_valuations TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON item_warehouse_stock TO {{app_role}};
GRANT EXECUTE ON FUNCTION seed_purchasing_defaults(uuid) TO {{app_role}};

ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO roles (tenant_id, code, name, is_system)
SELECT t.id, r.code, r.name, true
FROM tenants t
CROSS JOIN (VALUES ('buyer', 'Buyer'), ('warehouse', 'Warehouse Operator')) AS r (code, name)
ON CONFLICT (tenant_id, code) DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES
  ('pur.order.view'), ('pur.order.create'), ('pur.order.edit'), ('pur.receipt.view'), ('pur.receipt.post'), ('pur.receipt.cancel'), ('inv.stock.view')
) AS p (permission)
WHERE r.is_system AND r.code IN ('owner', 'administrator')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES ('pur.order.view'), ('pur.receipt.view'), ('inv.stock.view')) AS p (permission)
WHERE r.is_system AND r.code IN ('auditor', 'accountant')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES
  ('pur.order.view'), ('pur.order.create'), ('pur.order.edit'), ('pur.receipt.view'), ('inv.stock.view'),
  ('inv.item.view'), ('inv.price.view'), ('bp.partner.view'), ('bp.partner.create'), ('bp.partner.edit'), ('admin.branch.view')
) AS p (permission)
WHERE r.is_system AND r.code = 'buyer'
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES
  ('pur.order.view'), ('pur.receipt.view'), ('pur.receipt.post'), ('pur.receipt.cancel'), ('inv.stock.view'),
  ('inv.item.view'), ('bp.partner.view'), ('admin.branch.view')
) AS p (permission)
WHERE r.is_system AND r.code = 'warehouse'
ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

UPDATE plans SET modules = array_append(modules, 'pur') WHERE NOT ('pur' = ANY (modules));
UPDATE tenant_entitlements SET modules = array_append(modules, 'pur'), updated_at = now() WHERE NOT ('pur' = ANY (modules));
