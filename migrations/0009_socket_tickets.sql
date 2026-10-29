CREATE TABLE socket_tickets (
    session_id text PRIMARY KEY REFERENCES sessions(id),
    ticket_hash bytea NOT NULL UNIQUE,
    channel_id text NOT NULL,
    after_seq bigint NOT NULL CHECK (after_seq >= 0),
    expires_at timestamptz NOT NULL,
    used_at timestamptz
);
