ALTER TABLE sessions ADD COLUMN last_heartbeat_at timestamptz;
ALTER TABLE sessions ADD COLUMN heartbeat_seq bigint NOT NULL DEFAULT 0;
