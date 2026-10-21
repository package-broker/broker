-- pb:phase contract
SELECT json_extract('{}', '$ project_package.package_id missing same-org package rows: ' || n)
FROM (
  SELECT count(*) AS n FROM project_package AS pp
  WHERE NOT EXISTS (SELECT 1 FROM package AS p WHERE p.id = pp.package_id AND p.org_id = pp.org_id)
) WHERE n > 0;
CREATE TABLE project_package_0024 (
  org_id     TEXT NOT NULL REFERENCES organization (id),
  project_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  origin     TEXT NOT NULL CHECK (origin IN ('subscription', 'explicit', 'pattern')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ecosystem  TEXT NOT NULL CHECK (ecosystem IN ('composer', 'npm')),
  name       TEXT NOT NULL CHECK (name = lower(name)),
  PRIMARY KEY (project_id, package_id),
  FOREIGN KEY (org_id, project_id) REFERENCES project (org_id, id),
  FOREIGN KEY (org_id, package_id) REFERENCES package (org_id, id)
) STRICT, WITHOUT ROWID;
INSERT INTO project_package_0024 (org_id, project_id, package_id, origin, created_at, ecosystem, name)
  SELECT pp.org_id, pp.project_id, pp.package_id, pp.origin, pp.created_at, p.ecosystem, p.name
  FROM project_package AS pp JOIN package AS p ON p.id = pp.package_id AND p.org_id = pp.org_id;
DROP TABLE project_package;
ALTER TABLE project_package_0024 RENAME TO project_package;
CREATE INDEX IF NOT EXISTS project_package_package ON project_package (package_id);
CREATE INDEX IF NOT EXISTS project_package_name ON project_package (org_id, project_id, ecosystem, name);
CREATE INDEX IF NOT EXISTS version_package_id ON version (package_id, id);
