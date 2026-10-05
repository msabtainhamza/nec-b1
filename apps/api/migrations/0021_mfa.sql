GRANT UPDATE (totp_secret) ON platform_operators TO {{app_role}};

CREATE TABLE user_mfa (
  user_id uuid PRIMARY KEY REFERENCES users (id),
  secret_encrypted text NOT NULL,
  last_counter bigint,
  enabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON user_mfa TO {{app_role}};

CREATE TABLE user_mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id),
  code_hash text NOT NULL,
  used_at timestamptz
);
CREATE INDEX user_mfa_recovery_codes_user_idx ON user_mfa_recovery_codes (user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON user_mfa_recovery_codes TO {{app_role}};

CREATE TABLE mfa_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id),
  token_hash text NOT NULL,
  user_agent text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE UNIQUE INDEX mfa_challenges_token_hash_key ON mfa_challenges (token_hash);
GRANT SELECT, INSERT, UPDATE ON mfa_challenges TO {{app_role}};

CREATE TABLE company_security_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  require_admin_mfa boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE company_security_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_security_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY company_security_settings_tenant ON company_security_settings
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON company_security_settings TO {{app_role}};
