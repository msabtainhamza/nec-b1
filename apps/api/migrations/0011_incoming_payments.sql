ALTER TABLE outgoing_payments RENAME TO payments;
ALTER TABLE payments RENAME COLUMN vendor_id TO partner_id;
ALTER TABLE payments ADD COLUMN direction text NOT NULL DEFAULT 'outgoing' CHECK (direction IN ('outgoing', 'incoming'));
ALTER TABLE payments ALTER COLUMN direction DROP DEFAULT;
ALTER TABLE payments ADD CONSTRAINT payments_tenant_id_direction_key UNIQUE (tenant_id, id, direction);
ALTER TABLE payments ADD CONSTRAINT payments_cancellation_direction_fkey
  FOREIGN KEY (tenant_id, cancellation_of_id, direction) REFERENCES payments (tenant_id, id, direction);
ALTER INDEX outgoing_payments_single_cancellation_key RENAME TO payments_single_cancellation_key;
ALTER INDEX outgoing_payments_vendor_idx RENAME TO payments_partner_idx;
CREATE INDEX payments_direction_idx ON payments (tenant_id, direction, posted_at);
ALTER POLICY outgoing_payments_tenant ON payments RENAME TO payments_tenant;

CREATE OR REPLACE FUNCTION seed_banking_defaults(target_tenant uuid) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO numbering_series (tenant_id, document_type, name, prefix, next_number, is_default)
  VALUES (target_tenant, 'outgoing_payment', 'Primary', 'OP', 1, true),
         (target_tenant, 'incoming_payment', 'Primary', 'IP', 1, true)
  ON CONFLICT DO NOTHING;
END
$$;

ALTER TABLE numbering_series NO FORCE ROW LEVEL SECURITY;
SELECT seed_banking_defaults(id) FROM tenants;
ALTER TABLE numbering_series FORCE ROW LEVEL SECURITY;
