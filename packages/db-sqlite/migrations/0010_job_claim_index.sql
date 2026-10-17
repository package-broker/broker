CREATE INDEX job_claim_org ON job(org_id, run_at, id) WHERE state = 'queued';
CREATE INDEX job_lease_org ON job(org_id, lease_until) WHERE state = 'running';
