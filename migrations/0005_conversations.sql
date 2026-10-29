CREATE TABLE conversations (
    id text PRIMARY KEY,
    space_id text NOT NULL,
    channel_id text NOT NULL,
    created_by text NOT NULL,
    client_message_id text NOT NULL,
    summary text NOT NULL,
    expires_in_seconds integer NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    UNIQUE (space_id, id),
    UNIQUE (space_id, channel_id, id),
    UNIQUE (space_id, created_by, client_message_id),
    FOREIGN KEY (space_id, channel_id) REFERENCES channels(space_id, id),
    FOREIGN KEY (space_id, created_by) REFERENCES sessions(space_id, id)
);

CREATE TABLE conversation_participants (
    space_id text NOT NULL,
    conversation_id text NOT NULL,
    session_id text NOT NULL,
    PRIMARY KEY (conversation_id, session_id),
    FOREIGN KEY (space_id, conversation_id) REFERENCES conversations(space_id, id),
    FOREIGN KEY (space_id, session_id) REFERENCES sessions(space_id, id)
);
