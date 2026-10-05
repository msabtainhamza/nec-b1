ALTER TABLE sales_orders
  ADD COLUMN price_list_id uuid,
  ADD COLUMN payment_terms_id uuid,
  ADD COLUMN bill_to jsonb,
  ADD COLUMN ship_to jsonb,
  ADD FOREIGN KEY (tenant_id, price_list_id) REFERENCES price_lists (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, payment_terms_id) REFERENCES payment_terms (tenant_id, id);
