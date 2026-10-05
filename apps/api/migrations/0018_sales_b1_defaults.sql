ALTER TABLE sales_settings ALTER COLUMN price_tolerance_percent DROP NOT NULL;
ALTER TABLE sales_settings ALTER COLUMN price_tolerance_percent SET DEFAULT NULL;

ALTER TABLE ar_invoices
  ADD COLUMN payment_terms_id uuid,
  ADD FOREIGN KEY (tenant_id, payment_terms_id) REFERENCES payment_terms (tenant_id, id);
