CREATE TABLE accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code text NOT NULL CHECK (code ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,19}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  account_type text NOT NULL CHECK (account_type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  parent_id uuid,
  is_title boolean NOT NULL DEFAULT false,
  control_kind text CHECK (control_kind IN ('receivable', 'payable')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES accounts (tenant_id, id),
  CHECK (NOT (is_title AND control_kind IS NOT NULL)),
  CHECK (control_kind IS NULL OR (control_kind = 'receivable' AND account_type = 'asset') OR (control_kind = 'payable' AND account_type = 'liability'))
);

CREATE TABLE gl_determination (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  determination_key text NOT NULL,
  account_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, determination_key),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id)
);

CREATE TABLE fiscal_years (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code text NOT NULL CHECK (code ~ '^[0-9A-Za-z][0-9A-Za-z_-]{0,19}$'),
  start_date date NOT NULL,
  end_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK (end_date > start_date)
);

CREATE TABLE posting_periods (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  fiscal_year_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, fiscal_year_id) REFERENCES fiscal_years (tenant_id, id),
  CHECK (end_date >= start_date)
);
CREATE INDEX posting_periods_range_idx ON posting_periods (tenant_id, start_date, end_date);

CREATE TABLE numbering_series (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  document_type text NOT NULL CHECK (document_type ~ '^[a-z_]{2,40}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  prefix text NOT NULL DEFAULT '' CHECK (prefix ~ '^[A-Za-z0-9/-]{0,10}$'),
  next_number bigint NOT NULL DEFAULT 1 CHECK (next_number > 0),
  last_number bigint CHECK (last_number IS NULL OR last_number > 0),
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, document_type, name),
  CHECK (last_number IS NULL OR last_number >= next_number - 1)
);
CREATE UNIQUE INDEX numbering_series_default_key ON numbering_series (tenant_id, document_type) WHERE is_default;

CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  operation text NOT NULL,
  request_hash text NOT NULL,
  result_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key)
);

CREATE TABLE journal_entries (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  series_id uuid NOT NULL,
  number bigint NOT NULL,
  document_number text NOT NULL,
  source_type text NOT NULL CHECK (source_type ~ '^[a-z_]{2,40}$'),
  source_id uuid,
  posting_date date NOT NULL,
  document_date date NOT NULL,
  due_date date NOT NULL,
  period_id uuid NOT NULL,
  memo text,
  reference text,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_debit numeric(19, 4) NOT NULL CHECK (total_debit > 0),
  total_credit numeric(19, 4) NOT NULL,
  reversal_of_id uuid,
  reversal_reason text,
  posted_by uuid REFERENCES users (id),
  posted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, series_id, number),
  FOREIGN KEY (tenant_id, series_id) REFERENCES numbering_series (tenant_id, id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES posting_periods (tenant_id, id),
  FOREIGN KEY (tenant_id, reversal_of_id) REFERENCES journal_entries (tenant_id, id),
  CHECK (total_debit = total_credit),
  CHECK ((reversal_of_id IS NULL) = (reversal_reason IS NULL)),
  CHECK ((source_type = 'reversal') = (reversal_of_id IS NOT NULL))
);
CREATE UNIQUE INDEX journal_entries_single_reversal_key ON journal_entries (tenant_id, reversal_of_id) WHERE reversal_of_id IS NOT NULL;
CREATE INDEX journal_entries_date_idx ON journal_entries (tenant_id, posting_date);

CREATE TABLE journal_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  journal_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  account_id uuid NOT NULL,
  partner_id uuid,
  debit numeric(19, 4) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(19, 4) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  memo text,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, journal_id, line_no),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, partner_id) REFERENCES business_partners (tenant_id, id),
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);
CREATE INDEX journal_lines_account_idx ON journal_lines (tenant_id, account_id);

CREATE FUNCTION assert_journal_balanced() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target uuid;
  header_debit numeric;
  header_credit numeric;
  line_debit numeric;
  line_credit numeric;
  line_count integer;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    target := NEW.id;
  ELSE
    target := NEW.journal_id;
  END IF;
  SELECT total_debit, total_credit INTO header_debit, header_credit FROM journal_entries WHERE id = target;
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*) INTO line_debit, line_credit, line_count
    FROM journal_lines WHERE journal_id = target;
  IF line_count < 2 OR line_debit <> line_credit OR line_debit <> header_debit OR line_credit <> header_credit THEN
    RAISE EXCEPTION 'Journal % is not balanced or has fewer than two lines', target USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER journal_entries_balanced
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

CREATE TRIGGER journal_entries_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

CREATE TRIGGER journal_lines_immutable
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

CREATE FUNCTION seed_finance_defaults(target_tenant uuid, fiscal_year integer) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  template record;
  year_id uuid;
  month integer;
  period_start date;
BEGIN
  FOR template IN
    SELECT * FROM (VALUES
      (1, '1', 'Assets', 'asset', NULL, true, NULL),
      (2, '11', 'Current Assets', 'asset', '1', true, NULL),
      (3, '1100', 'Cash on Hand', 'asset', '11', false, NULL),
      (4, '1110', 'Bank Account', 'asset', '11', false, NULL),
      (5, '1200', 'Accounts Receivable', 'asset', '11', false, 'receivable'),
      (6, '1300', 'Inventory', 'asset', '11', false, NULL),
      (7, '1400', 'Input Tax Receivable', 'asset', '11', false, NULL),
      (8, '12', 'Non-current Assets', 'asset', '1', true, NULL),
      (9, '1500', 'Property and Equipment', 'asset', '12', false, NULL),
      (10, '2', 'Liabilities', 'liability', NULL, true, NULL),
      (11, '2100', 'Accounts Payable', 'liability', '2', false, 'payable'),
      (12, '2150', 'Goods Received Not Invoiced', 'liability', '2', false, NULL),
      (13, '2200', 'Output Tax Payable', 'liability', '2', false, NULL),
      (14, '2300', 'Accrued Liabilities', 'liability', '2', false, NULL),
      (15, '3', 'Equity', 'equity', NULL, true, NULL),
      (16, '3100', 'Share Capital', 'equity', '3', false, NULL),
      (17, '3200', 'Retained Earnings', 'equity', '3', false, NULL),
      (18, '3900', 'Opening Balance Equity', 'equity', '3', false, NULL),
      (19, '4', 'Income', 'income', NULL, true, NULL),
      (20, '4100', 'Sales Revenue', 'income', '4', false, NULL),
      (21, '4900', 'Other Income', 'income', '4', false, NULL),
      (22, '5', 'Expenses', 'expense', NULL, true, NULL),
      (23, '5100', 'Cost of Goods Sold', 'expense', '5', false, NULL),
      (24, '5200', 'Inventory Adjustments', 'expense', '5', false, NULL),
      (25, '5300', 'Price Differences', 'expense', '5', false, NULL),
      (26, '6100', 'Salaries and Wages', 'expense', '5', false, NULL),
      (27, '6200', 'Rent', 'expense', '5', false, NULL),
      (28, '6300', 'Utilities', 'expense', '5', false, NULL),
      (29, '6900', 'Rounding Differences', 'expense', '5', false, NULL)
    ) AS t (sort_order, code, name, account_type, parent_code, is_title, control_kind)
    ORDER BY sort_order
  LOOP
    INSERT INTO accounts (tenant_id, code, name, account_type, parent_id, is_title, control_kind)
    VALUES (
      target_tenant, template.code, template.name, template.account_type,
      (SELECT id FROM accounts WHERE tenant_id = target_tenant AND code = template.parent_code),
      template.is_title, template.control_kind
    )
    ON CONFLICT (tenant_id, code) DO NOTHING;
  END LOOP;

  INSERT INTO gl_determination (tenant_id, determination_key, account_id)
  SELECT target_tenant, d.determination_key, a.id
  FROM (VALUES
    ('cash', '1100'), ('bank', '1110'), ('receivable_control', '1200'), ('inventory', '1300'),
    ('input_tax', '1400'), ('payable_control', '2100'), ('goods_received_not_invoiced', '2150'),
    ('output_tax', '2200'), ('opening_balance', '3900'), ('revenue', '4100'), ('cogs', '5100'),
    ('inventory_adjustment', '5200'), ('price_difference', '5300'), ('rounding', '6900')
  ) AS d (determination_key, account_code)
  JOIN accounts a ON a.tenant_id = target_tenant AND a.code = d.account_code
  ON CONFLICT DO NOTHING;

  INSERT INTO numbering_series (tenant_id, document_type, name, prefix, next_number, is_default)
  VALUES (target_tenant, 'journal_entry', 'Primary', 'JE', 1, true)
  ON CONFLICT DO NOTHING;

  INSERT INTO fiscal_years (tenant_id, code, start_date, end_date)
  VALUES (target_tenant, fiscal_year::text, make_date(fiscal_year, 1, 1), make_date(fiscal_year, 12, 31))
  ON CONFLICT (tenant_id, code) DO NOTHING
  RETURNING id INTO year_id;
  IF year_id IS NOT NULL THEN
    FOR month IN 1..12 LOOP
      period_start := make_date(fiscal_year, month, 1);
      INSERT INTO posting_periods (tenant_id, fiscal_year_id, code, name, start_date, end_date)
      VALUES (
        target_tenant, year_id, to_char(period_start, 'YYYY-MM'), to_char(period_start, 'FMMonth YYYY'),
        period_start, (period_start + interval '1 month - 1 day')::date
      );
    END LOOP;
  END IF;
END
$$;

SELECT seed_finance_defaults(id, extract(year FROM now())::integer) FROM tenants;

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY accounts_tenant ON accounts
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE gl_determination ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_determination FORCE ROW LEVEL SECURITY;
CREATE POLICY gl_determination_tenant ON gl_determination
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE fiscal_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_years FORCE ROW LEVEL SECURITY;
CREATE POLICY fiscal_years_tenant ON fiscal_years
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE posting_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE posting_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY posting_periods_tenant ON posting_periods
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE numbering_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE numbering_series FORCE ROW LEVEL SECURITY;
CREATE POLICY numbering_series_tenant ON numbering_series
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys_tenant ON idempotency_keys
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY journal_entries_select ON journal_entries FOR SELECT USING (tenant_id = app_current_tenant_id());
CREATE POLICY journal_entries_insert ON journal_entries FOR INSERT WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY journal_lines_select ON journal_lines FOR SELECT USING (tenant_id = app_current_tenant_id());
CREATE POLICY journal_lines_insert ON journal_lines FOR INSERT WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON accounts TO {{app_role}};
GRANT SELECT, INSERT, UPDATE, DELETE ON gl_determination TO {{app_role}};
GRANT SELECT, INSERT ON fiscal_years TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON posting_periods TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON numbering_series TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON idempotency_keys TO {{app_role}};
GRANT SELECT, INSERT ON journal_entries TO {{app_role}};
GRANT SELECT, INSERT ON journal_lines TO {{app_role}};
GRANT EXECUTE ON FUNCTION seed_finance_defaults(uuid, integer) TO {{app_role}};

ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO roles (tenant_id, code, name, is_system)
SELECT t.id, 'accountant', 'Accountant', true FROM tenants t
ON CONFLICT (tenant_id, code) DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES
  ('fin.account.view'), ('fin.account.administer'), ('fin.journal.view'), ('fin.journal.post'),
  ('fin.journal.reverse'), ('fin.period.view'), ('fin.period.administer'), ('fin.setup.administer'),
  ('fin.report.view'), ('admin.numbering.view'), ('admin.numbering.administer')
) AS p (permission)
WHERE r.is_system AND r.code IN ('owner', 'administrator')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES
  ('fin.account.view'), ('fin.account.administer'), ('fin.journal.view'), ('fin.journal.post'),
  ('fin.journal.reverse'), ('fin.period.view'), ('fin.period.administer'), ('fin.setup.administer'),
  ('fin.report.view'), ('admin.numbering.view'), ('admin.company.view'), ('admin.branch.view'),
  ('admin.audit.view'), ('bp.partner.view')
) AS p (permission)
WHERE r.is_system AND r.code = 'accountant'
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission
FROM roles r
CROSS JOIN (VALUES ('fin.account.view'), ('fin.journal.view'), ('fin.period.view'), ('fin.report.view'), ('admin.numbering.view')) AS p (permission)
WHERE r.is_system AND r.code = 'auditor'
ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

UPDATE plans SET modules = array_append(modules, 'fin') WHERE NOT ('fin' = ANY (modules));
UPDATE tenant_entitlements SET modules = array_append(modules, 'fin'), updated_at = now() WHERE NOT ('fin' = ANY (modules));
