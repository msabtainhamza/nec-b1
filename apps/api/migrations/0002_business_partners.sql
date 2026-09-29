CREATE TABLE payment_terms (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$'),
  name text NOT NULL,
  due_days integer NOT NULL CHECK (due_days BETWEEN 0 AND 3650),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE bp_groups (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$'),
  name text NOT NULL,
  partner_type text NOT NULL CHECK (partner_type IN ('customer', 'supplier')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE business_partners (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  foreign_name text,
  partner_type text NOT NULL CHECK (partner_type IN ('customer', 'supplier', 'lead')),
  group_id uuid,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  tax_id text,
  phone text,
  email text,
  website text,
  payment_terms_id uuid,
  credit_limit numeric(19, 4) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  remarks text,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, group_id) REFERENCES bp_groups (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_terms_id) REFERENCES payment_terms (tenant_id, id)
);
CREATE INDEX business_partners_name_idx ON business_partners (tenant_id, lower(name));

CREATE TABLE bp_contacts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  name text NOT NULL,
  position text,
  phone text,
  email text,
  is_default boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, partner_id, line_no),
  FOREIGN KEY (tenant_id, partner_id) REFERENCES business_partners (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX bp_contacts_default_key ON bp_contacts (tenant_id, partner_id) WHERE is_default;

CREATE TABLE bp_addresses (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  address_type text NOT NULL CHECK (address_type IN ('bill_to', 'ship_to')),
  address_name text NOT NULL,
  street text,
  city text,
  state text,
  zip_code text,
  country char(2) CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  is_default boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, partner_id, line_no),
  UNIQUE (tenant_id, partner_id, address_type, address_name),
  FOREIGN KEY (tenant_id, partner_id) REFERENCES business_partners (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX bp_addresses_default_key ON bp_addresses (tenant_id, partner_id, address_type) WHERE is_default;

ALTER TABLE payment_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_terms FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_terms_tenant ON payment_terms
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE bp_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE bp_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY bp_groups_tenant ON bp_groups
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE business_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_partners FORCE ROW LEVEL SECURITY;
CREATE POLICY business_partners_tenant ON business_partners
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE bp_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bp_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY bp_contacts_tenant ON bp_contacts
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE bp_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE bp_addresses FORCE ROW LEVEL SECURITY;
CREATE POLICY bp_addresses_tenant ON bp_addresses
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON payment_terms TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON bp_groups TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON business_partners TO {{app_role}};
GRANT SELECT, INSERT, UPDATE, DELETE ON bp_contacts TO {{app_role}};
GRANT SELECT, INSERT, UPDATE, DELETE ON bp_addresses TO {{app_role}};

ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES ('bp.partner.view'), ('bp.partner.create'), ('bp.partner.edit'), ('bp.setup.administer')) AS p (permission)
WHERE r.is_system AND r.code IN ('owner', 'administrator')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, 'bp.partner.view'
FROM roles r
WHERE r.is_system AND r.code = 'auditor'
ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

ALTER TABLE bp_groups NO FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_terms NO FORCE ROW LEVEL SECURITY;
INSERT INTO bp_groups (tenant_id, code, name, partner_type)
SELECT t.id, g.code, g.name, g.partner_type
FROM tenants t
CROSS JOIN (VALUES ('CUSTOMERS', 'Customers', 'customer'), ('SUPPLIERS', 'Suppliers', 'supplier')) AS g (code, name, partner_type)
ON CONFLICT DO NOTHING;
INSERT INTO payment_terms (tenant_id, code, name, due_days)
SELECT t.id, p.code, p.name, p.due_days
FROM tenants t
CROSS JOIN (VALUES ('IMMEDIATE', 'Immediate', 0), ('NET30', 'Net 30 days', 30)) AS p (code, name, due_days)
ON CONFLICT DO NOTHING;
ALTER TABLE bp_groups FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_terms FORCE ROW LEVEL SECURITY;

UPDATE plans SET modules = array_append(modules, 'bp') WHERE NOT ('bp' = ANY (modules));
UPDATE tenant_entitlements SET modules = array_append(modules, 'bp'), updated_at = now() WHERE NOT ('bp' = ANY (modules));
