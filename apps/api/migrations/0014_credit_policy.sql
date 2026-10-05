CREATE TABLE sales_credit_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  mode text NOT NULL DEFAULT 'disabled' CHECK (mode IN ('disabled', 'warn', 'block')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
ALTER TABLE sales_credit_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_credit_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY sales_credit_settings_tenant ON sales_credit_settings
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON sales_credit_settings TO {{app_role}};

ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission FROM roles r
CROSS JOIN (VALUES ('sal.credit.administer'), ('sal.credit.override'), ('sal.credit.view')) AS p(permission)
WHERE r.is_system AND r.code IN ('owner', 'administrator') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT tenant_id, id, 'sal.credit.view' FROM roles
WHERE is_system AND code IN ('sales', 'accountant', 'auditor', 'warehouse') ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
