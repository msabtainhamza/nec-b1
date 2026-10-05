CREATE TABLE sales_quotations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  series_id uuid NOT NULL,
  number bigint NOT NULL,
  document_number text NOT NULL,
  customer_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  posting_date date NOT NULL,
  valid_until date NOT NULL,
  customer_reference text,
  remarks text,
  currency char(3) NOT NULL,
  total numeric(19, 4) NOT NULL CHECK (total >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'closed', 'cancelled')),
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
  CHECK (valid_until >= posting_date)
);
CREATE INDEX sales_quotations_customer_idx ON sales_quotations (tenant_id, customer_id);

CREATE TABLE sales_quotation_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  quotation_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  item_id uuid NOT NULL,
  description text NOT NULL,
  uom_id uuid NOT NULL,
  stocked boolean NOT NULL,
  warehouse_id uuid,
  quantity numeric(19, 4) NOT NULL CHECK (quantity > 0),
  unit_price numeric(19, 4) NOT NULL CHECK (unit_price >= 0),
  discount_percent numeric(7, 4) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  net_price numeric(19, 4) NOT NULL CHECK (net_price >= 0),
  line_total numeric(19, 4) NOT NULL CHECK (line_total >= 0),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, quotation_id, line_no),
  FOREIGN KEY (tenant_id, quotation_id) REFERENCES sales_quotations (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id),
  FOREIGN KEY (tenant_id, uom_id) REFERENCES units_of_measure (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id),
  CHECK (stocked = (warehouse_id IS NOT NULL))
);
CREATE INDEX sales_quotation_lines_item_idx ON sales_quotation_lines (tenant_id, item_id);

ALTER TABLE sales_orders ADD COLUMN quotation_id uuid;
ALTER TABLE sales_orders ADD FOREIGN KEY (tenant_id, quotation_id) REFERENCES sales_quotations (tenant_id, id);
CREATE UNIQUE INDEX sales_orders_quotation_key ON sales_orders (tenant_id, quotation_id) WHERE quotation_id IS NOT NULL;

ALTER TABLE sales_order_lines ADD COLUMN quotation_line_id uuid;
ALTER TABLE sales_order_lines ADD FOREIGN KEY (tenant_id, quotation_line_id) REFERENCES sales_quotation_lines (tenant_id, id);

CREATE FUNCTION seed_quotation_defaults(target_tenant uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO numbering_series (tenant_id, document_type, name, prefix, next_number, is_default)
  VALUES (target_tenant, 'sales_quotation', 'Primary', 'SQ', 1, true) ON CONFLICT DO NOTHING;
$$;
ALTER TABLE numbering_series NO FORCE ROW LEVEL SECURITY;
SELECT seed_quotation_defaults(id) FROM tenants;
ALTER TABLE numbering_series FORCE ROW LEVEL SECURITY;
GRANT EXECUTE ON FUNCTION seed_quotation_defaults(uuid) TO {{app_role}};

ALTER TABLE sales_quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_quotations FORCE ROW LEVEL SECURITY;
CREATE POLICY sales_quotations_tenant ON sales_quotations
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
ALTER TABLE sales_quotation_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_quotation_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY sales_quotation_lines_tenant ON sales_quotation_lines
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON sales_quotations TO {{app_role}};
GRANT SELECT, INSERT, DELETE ON sales_quotation_lines TO {{app_role}};

ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission FROM roles r
CROSS JOIN (VALUES ('sal.quotation.view'), ('sal.quotation.create'), ('sal.quotation.edit')) AS p(permission)
WHERE r.is_system AND r.code IN ('owner', 'administrator', 'sales') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT tenant_id, id, 'sal.quotation.view' FROM roles
WHERE is_system AND code IN ('accountant', 'auditor') ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
