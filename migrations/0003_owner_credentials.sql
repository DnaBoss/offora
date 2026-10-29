CREATE TABLE owner_credentials (
    id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES owners(id),
    token_hash bytea NOT NULL UNIQUE,
    revoked_at timestamptz
);
