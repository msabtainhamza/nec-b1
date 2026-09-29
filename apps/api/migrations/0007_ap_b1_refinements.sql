ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_quantity_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_quantity_or_value_check CHECK (quantity <> 0 OR value <> 0);

CREATE TABLE tax_codes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  purpose text NOT NULL CHECK (purpose IN ('purchase', 'sales', 'both')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE tax_code_rates (
  tenant_id uuid NOT NULL,
  tax_code_id uuid NOT NULL,
  valid_from date NOT NULL,
  rate numeric(7, 4) NOT NULL CHECK (rate >= 0 AND rate <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, tax_code_id, valid_from),
  FOREIGN KEY (tenant_id, tax_code_id) REFERENCES tax_codes (tenant_id, id)
);

ALTER TABLE ap_invoices ADD COLUMN document_type text NOT NULL DEFAULT 'item' CHECK (document_type IN ('item', 'service'));
ALTER TABLE ap_invoices ADD COLUMN subtotal numeric(19, 4);
ALTER TABLE ap_invoices ADD COLUMN tax_total numeric(19, 4) NOT NULL DEFAULT 0 CHECK (tax_total >= 0);
ALTER TABLE ap_invoices NO FORCE ROW LEVEL SECURITY;
UPDATE ap_invoices SET subtotal = total;
ALTER TABLE ap_invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE ap_invoices ALTER COLUMN subtotal SET NOT NULL;
ALTER TABLE ap_invoices ADD CONSTRAINT ap_invoices_total_components_check CHECK (total = subtotal + tax_total);

ALTER TABLE ap_invoice_lines ADD COLUMN line_kind text NOT NULL DEFAULT 'receipt' CHECK (line_kind IN ('receipt', 'item', 'account'));
ALTER TABLE ap_invoice_lines ALTER COLUMN receipt_id DROP NOT NULL;
ALTER TABLE ap_invoice_lines ALTER COLUMN receipt_line_id DROP NOT NULL;
ALTER TABLE ap_invoice_lines ALTER COLUMN order_line_id DROP NOT NULL;
ALTER TABLE ap_invoice_lines ALTER COLUMN item_id DROP NOT NULL;
ALTER TABLE ap_invoice_lines ALTER COLUMN receipt_price DROP NOT NULL;
ALTER TABLE ap_invoice_lines ADD COLUMN account_id uuid;
ALTER TABLE ap_invoice_lines ADD COLUMN warehouse_id uuid;
ALTER TABLE ap_invoice_lines ADD COLUMN tax_code_id uuid;
ALTER TABLE ap_invoice_lines ADD COLUMN tax_rate numeric(7, 4) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0);
ALTER TABLE ap_invoice_lines ADD COLUMN tax_amount numeric(19, 4) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0);
ALTER TABLE ap_invoice_lines ADD COLUMN stock_revaluation numeric(19, 4) NOT NULL DEFAULT 0;
ALTER TABLE ap_invoice_lines ADD COLUMN price_difference numeric(19, 4) NOT NULL DEFAULT 0;
ALTER TABLE ap_invoice_lines ADD CONSTRAINT ap_invoice_lines_account_fk FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id);
ALTER TABLE ap_invoice_lines ADD CONSTRAINT ap_invoice_lines_warehouse_fk FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses (tenant_id, id);
ALTER TABLE ap_invoice_lines ADD CONSTRAINT ap_invoice_lines_tax_code_fk FOREIGN KEY (tenant_id, tax_code_id) REFERENCES tax_codes (tenant_id, id);
ALTER TABLE ap_invoice_lines ADD CONSTRAINT ap_invoice_lines_kind_check CHECK (
  (line_kind = 'receipt' AND receipt_line_id IS NOT NULL AND receipt_id IS NOT NULL AND item_id IS NOT NULL AND receipt_price IS NOT NULL AND account_id IS NULL)
  OR (line_kind = 'item' AND receipt_line_id IS NULL AND item_id IS NOT NULL AND account_id IS NULL)
  OR (line_kind = 'account' AND receipt_line_id IS NULL AND item_id IS NULL AND account_id IS NOT NULL)
);

CREATE OR REPLACE FUNCTION seed_tax_defaults(target_tenant uuid) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  code_id uuid;
BEGIN
  INSERT INTO tax_codes (tenant_id, code, name, purpose)
  VALUES (target_tenant, 'NOTAX', 'No tax', 'both')
  ON CONFLICT (tenant_id, code) DO NOTHING
  RETURNING id INTO code_id;
  IF code_id IS NOT NULL THEN
    INSERT INTO tax_code_rates (tenant_id, tax_code_id, valid_from, rate) VALUES (target_tenant, code_id, DATE '2000-01-01', 0);
  END IF;
END
$$;

SELECT seed_tax_defaults(id) FROM tenants;

ALTER TABLE tax_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tax_codes_tenant ON tax_codes
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE tax_code_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_code_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tax_code_rates_tenant ON tax_code_rates
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON tax_codes TO {{app_role}};
GRANT SELECT, INSERT ON tax_code_rates TO {{app_role}};
GRANT EXECUTE ON FUNCTION seed_tax_defaults(uuid) TO {{app_role}};
