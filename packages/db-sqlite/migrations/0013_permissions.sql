-- pb:phase expand

UPDATE cache_epoch
SET version = hex(randomblob(16))
WHERE org_id IN (
  SELECT org_id
  FROM role
  WHERE
    key = 'organization_admin'
    AND is_system = 1
    AND protects_last_holder = 1
    AND (
      SELECT count(*)
      FROM role_permission p
      WHERE p.org_id = role.org_id
        AND p.role_id = role.id
        AND p.permission IN ('org:packages:manage', 'org:import:write', 'org:import:approve')
    ) < 3);

UPDATE role
SET revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE
  key = 'organization_admin'
  AND is_system = 1
  AND protects_last_holder = 1
  AND (
    SELECT count(*)
    FROM role_permission p
    WHERE p.org_id = role.org_id
      AND p.role_id = role.id
      AND p.permission IN ('org:packages:manage', 'org:import:write', 'org:import:approve')
  ) < 3;

INSERT INTO role_permission (org_id, role_id, permission)
SELECT r.org_id, r.id, j.permission
FROM role r
CROSS JOIN (
  SELECT 'org:packages:manage' AS permission
  UNION ALL
  SELECT 'org:import:write'
  UNION ALL
  SELECT 'org:import:approve'
) j
WHERE r.key = 'organization_admin'
  AND r.is_system = 1
  AND r.protects_last_holder = 1
ON CONFLICT DO NOTHING;
