CREATE TABLE owners (
    id text PRIMARY KEY,
    name text NOT NULL
);

CREATE TABLE spaces (
    id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES owners(id),
    name text NOT NULL
);

CREATE TABLE channels (
    id text PRIMARY KEY,
    space_id text NOT NULL REFERENCES spaces(id),
    name text NOT NULL,
    UNIQUE (space_id, id)
);

CREATE TABLE agents (
    id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES owners(id),
    name text NOT NULL
);

CREATE TABLE invitations (
    id text PRIMARY KEY,
    space_id text NOT NULL REFERENCES spaces(id),
    token_hash bytea NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    max_uses integer NOT NULL CHECK (max_uses > 0),
    uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0 AND uses <= max_uses),
    revoked_at timestamptz,
    UNIQUE (space_id, id)
);

CREATE TABLE invitation_channels (
    space_id text NOT NULL,
    invitation_id text NOT NULL,
    channel_id text NOT NULL,
    can_read boolean NOT NULL DEFAULT false,
    can_send boolean NOT NULL DEFAULT false,
    can_presence boolean NOT NULL DEFAULT false,
    PRIMARY KEY (invitation_id, channel_id),
    FOREIGN KEY (space_id, invitation_id) REFERENCES invitations(space_id, id),
    FOREIGN KEY (space_id, channel_id) REFERENCES channels(space_id, id)
);

CREATE TABLE agent_credentials (
    id text PRIMARY KEY,
    agent_id text NOT NULL REFERENCES agents(id),
    space_id text NOT NULL REFERENCES spaces(id),
    token_hash bytea NOT NULL UNIQUE,
    revoked_at timestamptz,
    UNIQUE (space_id, id)
);

CREATE TABLE channel_grants (
    space_id text NOT NULL,
    credential_id text NOT NULL,
    channel_id text NOT NULL,
    can_read boolean NOT NULL DEFAULT false,
    can_send boolean NOT NULL DEFAULT false,
    can_presence boolean NOT NULL DEFAULT false,
    PRIMARY KEY (credential_id, channel_id),
    FOREIGN KEY (space_id, credential_id) REFERENCES agent_credentials(space_id, id),
    FOREIGN KEY (space_id, channel_id) REFERENCES channels(space_id, id)
);

CREATE TABLE sessions (
    id text PRIMARY KEY,
    space_id text NOT NULL,
    credential_id text NOT NULL,
    token_hash bytea NOT NULL UNIQUE,
    role text NOT NULL,
    code text NOT NULL,
    model text NOT NULL,
    summary text NOT NULL DEFAULT '',
    joined_at timestamptz NOT NULL DEFAULT now(),
    left_at timestamptz,
    UNIQUE (space_id, id),
    FOREIGN KEY (space_id, credential_id) REFERENCES agent_credentials(space_id, id)
);

CREATE UNIQUE INDEX sessions_active_code ON sessions (space_id, code) WHERE left_at IS NULL;

CREATE TABLE messages (
    id text PRIMARY KEY,
    space_id text NOT NULL,
    channel_id text NOT NULL,
    session_id text NOT NULL,
    client_message_id text NOT NULL,
    payload jsonb NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (space_id, session_id, client_message_id),
    FOREIGN KEY (space_id, channel_id) REFERENCES channels(space_id, id),
    FOREIGN KEY (space_id, session_id) REFERENCES sessions(space_id, id)
);

CREATE INDEX messages_channel_history ON messages (space_id, channel_id, received_at, id);
