CREATE TABLE units_of_measure (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,9}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  decimals smallint NOT NULL DEFAULT 0 CHECK (decimals BETWEEN 0 AND 4),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE item_groups (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  inventory_account_id uuid,
  cogs_account_id uuid,
  revenue_account_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, inventory_account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, cogs_account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, revenue_account_id) REFERENCES accounts (tenant_id, id)
);

CREATE TABLE warehouses (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  branch_id uuid NOT NULL,
  inventory_account_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, inventory_account_id) REFERENCES accounts (tenant_id, id)
);

ALTER TABLE branches ADD COLUMN default_warehouse_id uuid;
ALTER TABLE branches ADD CONSTRAINT branches_default_warehouse_fk
  FOREIGN KEY (tenant_id, default_warehouse_id) REFERENCES warehouses (tenant_id, id);

CREATE TABLE items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  foreign_name text,
  item_type text NOT NULL CHECK (item_type IN ('inventory', 'non_inventory', 'service')),
  is_sales_item boolean NOT NULL DEFAULT true,
  is_purchase_item boolean NOT NULL DEFAULT true,
  group_id uuid NOT NULL,
  uom_id uuid NOT NULL,
  barcode text,
  default_warehouse_id uuid,
  reorder_point numeric(19, 4) CHECK (reorder_point IS NULL OR reorder_point >= 0),
  preferred_vendor_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  remarks text,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, group_id) REFERENCES item_groups (tenant_id, id),
  FOREIGN KEY (tenant_id, uom_id) REFERENCES units_of_measure (tenant_id, id),
  FOREIGN KEY (tenant_id, default_warehouse_id) REFERENCES warehouses (tenant_id, id),
  FOREIGN KEY (tenant_id, preferred_vendor_id) REFERENCES business_partners (tenant_id, id),
  CHECK (is_sales_item OR is_purchase_item),
  CHECK (item_type = 'inventory' OR (default_warehouse_id IS NULL AND reorder_point IS NULL))
);
CREATE INDEX items_name_idx ON items (tenant_id, lower(name));
CREATE UNIQUE INDEX items_barcode_key ON items (tenant_id, barcode) WHERE barcode IS NOT NULL;

CREATE TABLE price_lists (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  purpose text NOT NULL CHECK (purpose IN ('sales', 'purchase')),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  valid_from date,
  valid_to date,
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE UNIQUE INDEX price_lists_default_key ON price_lists (tenant_id, purpose) WHERE is_default;

CREATE TABLE item_prices (
  tenant_id uuid NOT NULL,
  price_list_id uuid NOT NULL,
  item_id uuid NOT NULL,
  price numeric(19, 4) NOT NULL CHECK (price >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, price_list_id, item_id),
  FOREIGN KEY (tenant_id, price_list_id) REFERENCES price_lists (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id)
);

CREATE FUNCTION seed_inventory_defaults(target_tenant uuid) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  default_branch uuid;
  base_currency char(3);
  warehouse_id uuid;
BEGIN
  SELECT t.default_branch_id, t.base_currency INTO default_branch, base_currency FROM tenants t WHERE t.id = target_tenant;

  INSERT INTO units_of_measure (tenant_id, code, name, decimals)
  VALUES (target_tenant, 'EA', 'Each', 0), (target_tenant, 'BOX', 'Box', 0), (target_tenant, 'KG', 'Kilogram', 3), (target_tenant, 'L', 'Litre', 3)
  ON CONFLICT DO NOTHING;

  INSERT INTO item_groups (tenant_id, code, name)
  VALUES (target_tenant, 'GENERAL', 'Items'), (target_tenant, 'SERVICES', 'Services')
  ON CONFLICT DO NOTHING;

  IF default_branch IS NOT NULL THEN
    INSERT INTO warehouses (tenant_id, code, name, branch_id)
    VALUES (target_tenant, 'WH01', 'General Warehouse', default_branch)
    ON CONFLICT (tenant_id, code) DO NOTHING
    RETURNING id INTO warehouse_id;
    IF warehouse_id IS NOT NULL THEN
      UPDATE branches SET default_warehouse_id = warehouse_id
      WHERE tenant_id = target_tenant AND id = default_branch AND default_warehouse_id IS NULL;
    END IF;
  END IF;

  INSERT INTO price_lists (tenant_id, code, name, purpose, currency, is_default)
  VALUES (target_tenant, 'SALES', 'Sales Price', 'sales', base_currency, true),
         (target_tenant, 'PURCHASE', 'Purchase Price', 'purchase', base_currency, true)
  ON CONFLICT DO NOTHING;
END
$$;

ALTER TABLE branches NO FORCE ROW LEVEL SECURITY;
SELECT seed_inventory_defaults(id) FROM tenants;
ALTER TABLE branches FORCE ROW LEVEL SECURITY;

ALTER TABLE units_of_measure ENABLE ROW LEVEL SECURITY;
ALTER TABLE units_of_measure FORCE ROW LEVEL SECURITY;
CREATE POLICY units_of_measure_tenant ON units_of_measure
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE item_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY item_groups_tenant ON item_groups
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouses FORCE ROW LEVEL SECURITY;
CREATE POLICY warehouses_tenant ON warehouses
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE items FORCE ROW LEVEL SECURITY;
CREATE POLICY items_tenant ON items
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE price_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_lists FORCE ROW LEVEL SECURITY;
CREATE POLICY price_lists_tenant ON price_lists
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE item_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY item_prices_tenant ON item_prices
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON units_of_measure TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON item_groups TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON warehouses TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON items TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON price_lists TO {{app_role}};
GRANT SELECT, INSERT, UPDATE, DELETE ON item_prices TO {{app_role}};
GRANT UPDATE (default_warehouse_id) ON branches TO {{app_role}};
GRANT EXECUTE ON FUNCTION seed_inventory_defaults(uuid) TO {{app_role}};

ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES ('inv.item.view'), ('inv.item.create'), ('inv.item.edit'), ('inv.price.view'), ('inv.price.administer'), ('inv.setup.administer')) AS p (permission)
WHERE r.is_system AND r.code IN ('owner', 'administrator')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES ('inv.item.view'), ('inv.price.view')) AS p (permission)
WHERE r.is_system AND r.code IN ('auditor', 'accountant')
ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

UPDATE plans SET modules = array_append(modules, 'inv') WHERE NOT ('inv' = ANY (modules));
UPDATE tenant_entitlements SET modules = array_append(modules, 'inv'), updated_at = now() WHERE NOT ('inv' = ANY (modules));
