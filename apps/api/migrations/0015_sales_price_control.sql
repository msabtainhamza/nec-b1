CREATE TABLE sales_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  price_tolerance_percent numeric(7, 4) NOT NULL DEFAULT 0 CHECK (price_tolerance_percent >= 0 AND price_tolerance_percent <= 100),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sales_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY sales_settings_tenant ON sales_settings
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON sales_settings TO {{app_role}};

ALTER TABLE ar_invoices ADD COLUMN price_override boolean NOT NULL DEFAULT false;
ALTER TABLE ar_invoice_lines ADD COLUMN source_price numeric(19, 4);

ALTER TABLE ar_invoice_lines NO FORCE ROW LEVEL SECURITY;
ALTER TABLE delivery_lines NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sales_order_lines NO FORCE ROW LEVEL SECURITY;
UPDATE ar_invoice_lines l SET source_price = coalesce(
  (SELECT d.net_price FROM delivery_lines d WHERE d.tenant_id = l.tenant_id AND d.id = l.delivery_line_id),
  (SELECT o.net_price FROM sales_order_lines o WHERE o.tenant_id = l.tenant_id AND o.id = l.order_line_id)
);
ALTER TABLE sales_order_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE delivery_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE ar_invoice_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE ar_invoice_lines ALTER COLUMN source_price SET NOT NULL;

ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission FROM roles r
CROSS JOIN (VALUES ('sal.invoice.override'), ('sal.setup.administer')) AS p (permission)
WHERE r.is_system AND r.code IN ('owner', 'administrator') ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
