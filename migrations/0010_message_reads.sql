CREATE TABLE message_reads (
    message_id text NOT NULL REFERENCES messages(id),
    space_id text NOT NULL,
    session_id text NOT NULL,
    read_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, session_id),
    FOREIGN KEY (space_id, session_id) REFERENCES sessions(space_id, id)
);
