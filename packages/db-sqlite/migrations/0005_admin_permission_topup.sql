-- Package Broker 2.0, migration 0005. SQLite dialect (Cloudflare D1, better-sqlite3).
-- Tops up the protected Organization Admin role with the catalogue permissions added after 0001.
-- Expand only: data rows, no schema change, no triggers. Editable roles are never touched.

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
        AND p.permission IN ('org:projects:archive', 'project:service-principals:write')
    ) < 2);

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
      AND p.permission IN ('org:projects:archive', 'project:service-principals:write')
  ) < 2;

INSERT INTO role_permission (org_id, role_id, permission)
SELECT r.org_id, r.id, j.permission
FROM role r
CROSS JOIN (
  SELECT 'org:projects:archive' AS permission
  UNION ALL
  SELECT 'project:service-principals:write'
) j
WHERE r.key = 'organization_admin'
  AND r.is_system = 1
  AND r.protects_last_holder = 1
ON CONFLICT DO NOTHING;
