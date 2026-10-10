-- A confirmed external indicator survives a failed monitoring-state commit. (FR-TG-06, SRS T-25)
ALTER TABLE idempotency_keys ADD COLUMN outcome jsonb;
