CREATE TABLE auto_offices (
    key_hash bytea PRIMARY KEY,
    owner_id text NOT NULL REFERENCES owners(id),
    space_id text NOT NULL REFERENCES spaces(id),
    channel_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (space_id, channel_id) REFERENCES channels(space_id, id)
);
