ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT r.tenant_id, r.id, p.permission FROM roles r
CROSS JOIN (VALUES ('fin.period.close'), ('fin.period.reopen')) AS p (permission)
WHERE r.is_system AND r.code IN ('owner', 'administrator') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (tenant_id, role_id, permission)
SELECT tenant_id, id, 'fin.period.close' FROM roles
WHERE is_system AND code = 'accountant' ON CONFLICT DO NOTHING;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
