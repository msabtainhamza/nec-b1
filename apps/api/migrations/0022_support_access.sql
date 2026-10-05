CREATE TABLE support_grants (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  granted_by uuid NOT NULL REFERENCES users (id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users (id),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  CHECK (expires_at > created_at)
);
CREATE INDEX support_grants_tenant_idx ON support_grants (tenant_id, expires_at);
ALTER TABLE support_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY support_grants_tenant ON support_grants
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
GRANT SELECT, INSERT ON support_grants TO {{app_role}};
GRANT UPDATE (revoked_at, revoked_by) ON support_grants TO {{app_role}};
