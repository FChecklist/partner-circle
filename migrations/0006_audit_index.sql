-- 0006: index for the erasure-request lookups (one open request per person, owner queue).
CREATE INDEX IF NOT EXISTS audit_action_target ON audit_log(action, target);
