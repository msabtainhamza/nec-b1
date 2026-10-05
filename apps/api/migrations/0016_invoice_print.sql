CREATE TABLE company_profiles (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  street text CHECK (char_length(street) <= 200),
  city text CHECK (char_length(city) <= 100),
  state text CHECK (char_length(state) <= 100),
  zip_code text CHECK (char_length(zip_code) <= 20),
  country text CHECK (char_length(country) <= 100),
  tax_number text CHECK (char_length(tax_number) <= 50),
  phone text CHECK (char_length(phone) <= 50),
  email text CHECK (char_length(email) <= 200),
  invoice_footer text CHECK (char_length(invoice_footer) <= 1000),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE company_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY company_profiles_tenant ON company_profiles
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON company_profiles TO {{app_role}};

ALTER TABLE ar_invoices ADD COLUMN print_snapshot jsonb;
