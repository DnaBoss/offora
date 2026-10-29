LOCK TABLE messages IN ACCESS EXCLUSIVE MODE;

CREATE TABLE channel_event_cursors (
    space_id text NOT NULL,
    channel_id text NOT NULL,
    last_seq bigint NOT NULL CHECK (last_seq > 0),
    PRIMARY KEY (space_id, channel_id),
    FOREIGN KEY (space_id, channel_id) REFERENCES channels(space_id, id)
);

CREATE TABLE channel_events (
    space_id text NOT NULL,
    channel_id text NOT NULL,
    seq bigint NOT NULL CHECK (seq > 0),
    event_id text NOT NULL UNIQUE,
    event_type text NOT NULL,
    actor_session_id text NOT NULL,
    conversation_id text,
    message_id text,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (space_id, channel_id, seq),
    FOREIGN KEY (space_id, channel_id) REFERENCES channels(space_id, id),
    FOREIGN KEY (space_id, actor_session_id) REFERENCES sessions(space_id, id),
    FOREIGN KEY (space_id, channel_id, conversation_id) REFERENCES conversations(space_id, channel_id, id),
    FOREIGN KEY (message_id) REFERENCES messages(id)
);

INSERT INTO channel_events (space_id, channel_id, seq, event_id, event_type, actor_session_id, conversation_id, message_id, occurred_at)
SELECT d.space_id, d.channel_id, d.seq, m.id, 'conversation.message', m.session_id, m.conversation_id, m.id, m.received_at
FROM message_delivery d JOIN messages m ON m.id=d.message_id;

INSERT INTO channel_event_cursors (space_id, channel_id, last_seq)
SELECT space_id, channel_id, max(seq) FROM channel_events GROUP BY space_id, channel_id;
