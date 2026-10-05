CREATE TABLE approval_templates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  document_type text NOT NULL CHECK (document_type IN ('sales_order', 'purchase_order')),
  min_total numeric(19, 4) NOT NULL DEFAULT 0 CHECK (min_total >= 0),
  approver_role_id uuid NOT NULL,
  required_approvals integer NOT NULL DEFAULT 1 CHECK (required_approvals BETWEEN 1 AND 10),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, approver_role_id) REFERENCES roles (tenant_id, id)
);

CREATE TABLE approval_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  template_id uuid NOT NULL,
  document_type text NOT NULL CHECK (document_type IN ('sales_order', 'purchase_order')),
  originator_id uuid NOT NULL REFERENCES users (id),
  partner_id uuid NOT NULL,
  total numeric(19, 4) NOT NULL,
  payload jsonb NOT NULL,
  remarks text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'completed')),
  document_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES approval_templates (tenant_id, id),
  FOREIGN KEY (tenant_id, partner_id) REFERENCES business_partners (tenant_id, id)
);
CREATE INDEX approval_requests_status_idx ON approval_requests (tenant_id, status);

CREATE TABLE approval_decisions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  request_id uuid NOT NULL,
  approver_id uuid NOT NULL REFERENCES users (id),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  remarks text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, request_id, approver_id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES approval_requests (tenant_id, id)
);

ALTER TABLE approval_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_templates_tenant ON approval_templates USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_requests_tenant ON approval_requests USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
ALTER TABLE approval_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_decisions_tenant ON approval_decisions USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON approval_templates TO {{app_role}};
GRANT SELECT, INSERT ON approval_requests TO {{app_role}};
GRANT UPDATE (status, document_id, version, updated_at) ON approval_requests TO {{app_role}};
GRANT SELECT, INSERT ON approval_decisions TO {{app_role}};

ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission FROM roles r
CROSS JOIN (VALUES ('admin.approval.view'), ('admin.approval.administer')) AS p (permission)
WHERE r.is_system AND r.code IN ('owner', 'administrator') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT tenant_id, id, 'admin.approval.view' FROM roles
WHERE is_system AND code IN ('accountant', 'auditor', 'sales', 'buyer') ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
