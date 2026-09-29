CREATE FUNCTION app_current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app_current_invitation_token_hash() RETURNS text
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.invitation_token_hash', true), '') $$;

CREATE FUNCTION reject_modification() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  modules text[] NOT NULL DEFAULT '{}',
  max_active_seats integer NOT NULL CHECK (max_active_seats >= 0),
  max_employees integer NOT NULL CHECK (max_employees >= 0),
  max_branches integer NOT NULL CHECK (max_branches >= 0),
  max_storage_bytes bigint NOT NULL CHECK (max_storage_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_operators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  totp_secret text NOT NULL,
  totp_last_counter bigint,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email = lower(email))
);
CREATE UNIQUE INDEX platform_operators_email_key ON platform_operators (email);

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  legal_name text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deletion_requested')),
  base_currency char(3) NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  time_zone text NOT NULL,
  created_by_operator_id uuid REFERENCES platform_operators (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);
CREATE UNIQUE INDEX tenants_code_key ON tenants (code);

CREATE TABLE subscriptions (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  plan_id uuid NOT NULL REFERENCES plans (id),
  state text NOT NULL CHECK (state IN ('trial', 'active', 'past_due', 'grace', 'suspended', 'cancelled')),
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  retention_ends_at timestamptz,
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE tenant_entitlements (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  modules text[] NOT NULL DEFAULT '{}',
  max_active_seats integer NOT NULL CHECK (max_active_seats >= 0),
  max_employees integer NOT NULL CHECK (max_employees >= 0),
  max_branches integer NOT NULL CHECK (max_branches >= 0),
  max_storage_bytes bigint NOT NULL CHECK (max_storage_bytes >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email = lower(email))
);
CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('user', 'operator')),
  user_id uuid REFERENCES users (id),
  operator_id uuid REFERENCES platform_operators (id),
  active_tenant_id uuid REFERENCES tenants (id),
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  CHECK ((subject_type = 'user' AND user_id IS NOT NULL AND operator_id IS NULL)
      OR (subject_type = 'operator' AND operator_id IS NOT NULL AND user_id IS NULL AND active_tenant_id IS NULL))
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions (id),
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE UNIQUE INDEX refresh_tokens_hash_key ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_session_idx ON refresh_tokens (session_id);

CREATE TABLE platform_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid REFERENCES platform_operators (id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  tenant_id uuid REFERENCES tenants (id),
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  details jsonb NOT NULL DEFAULT '{}',
  correlation_id text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_events_time_idx ON platform_audit_events (occurred_at DESC);
CREATE TRIGGER platform_audit_events_append_only
  BEFORE UPDATE OR DELETE ON platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

CREATE TABLE memberships (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  user_id uuid NOT NULL REFERENCES users (id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE roles (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code text NOT NULL,
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE role_permissions (
  tenant_id uuid NOT NULL,
  role_id uuid NOT NULL,
  permission text NOT NULL CHECK (permission ~ '^[a-z]+\.[a-z_]+\.[a-z_]+$'),
  PRIMARY KEY (tenant_id, role_id, permission),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE membership_roles (
  tenant_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  role_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, membership_id, role_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id)
);

CREATE TABLE invitations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  email text NOT NULL CHECK (email = lower(email)),
  role_ids uuid[] NOT NULL DEFAULT '{}',
  token_hash text NOT NULL,
  invited_by_user_id uuid REFERENCES users (id),
  invited_by_operator_id uuid REFERENCES platform_operators (id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_user_id uuid REFERENCES users (id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX invitations_token_hash_key ON invitations (token_hash);
CREATE UNIQUE INDEX invitations_pending_email_key ON invitations (tenant_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE branches (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$'),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

ALTER TABLE tenants ADD COLUMN default_branch_id uuid;
ALTER TABLE tenants ADD CONSTRAINT tenants_default_branch_fk
  FOREIGN KEY (id, default_branch_id) REFERENCES branches (tenant_id, id);

CREATE TABLE audit_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'operator', 'system')),
  actor_id uuid,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  before_data jsonb,
  after_data jsonb,
  correlation_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE INDEX audit_events_tenant_time_idx ON audit_events (tenant_id, occurred_at DESC);
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_select ON memberships FOR SELECT
  USING (tenant_id = app_current_tenant_id() OR user_id = app_current_user_id());
CREATE POLICY memberships_insert ON memberships FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY memberships_update ON memberships FOR UPDATE
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY invitations_select ON invitations FOR SELECT
  USING (tenant_id = app_current_tenant_id() OR token_hash = app_current_invitation_token_hash());
CREATE POLICY invitations_insert ON invitations FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY invitations_update ON invitations FOR UPDATE
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_tenant ON roles
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY role_permissions_tenant ON role_permissions
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE membership_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_roles_tenant ON membership_roles
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches FORCE ROW LEVEL SECURITY;
CREATE POLICY branches_tenant ON branches
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_select ON audit_events FOR SELECT
  USING (tenant_id = app_current_tenant_id());
CREATE POLICY audit_events_insert ON audit_events FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT ON plans TO {{app_role}};
GRANT SELECT, UPDATE (totp_last_counter) ON platform_operators TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON tenants TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON subscriptions TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON tenant_entitlements TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON users TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON sessions TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON refresh_tokens TO {{app_role}};
GRANT SELECT, INSERT ON platform_audit_events TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON memberships TO {{app_role}};
GRANT SELECT, INSERT, UPDATE, DELETE ON roles TO {{app_role}};
GRANT SELECT, INSERT, DELETE ON role_permissions TO {{app_role}};
GRANT SELECT, INSERT, DELETE ON membership_roles TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON invitations TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON branches TO {{app_role}};
GRANT SELECT, INSERT ON audit_events TO {{app_role}};

GRANT SELECT ON tenants, subscriptions, tenant_entitlements, memberships TO {{worker_role}};
GRANT SELECT, INSERT ON audit_events TO {{worker_role}};
