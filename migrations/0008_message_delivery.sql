LOCK TABLE messages IN ACCESS EXCLUSIVE MODE;

CREATE TABLE channel_message_cursors (
    space_id text NOT NULL,
    channel_id text NOT NULL,
    last_seq bigint NOT NULL CHECK (last_seq > 0),
    PRIMARY KEY (space_id, channel_id),
    FOREIGN KEY (space_id, channel_id) REFERENCES channels(space_id, id)
);

CREATE TABLE message_delivery (
    space_id text NOT NULL,
    channel_id text NOT NULL,
    seq bigint NOT NULL CHECK (seq > 0),
    message_id text NOT NULL UNIQUE REFERENCES messages(id),
    PRIMARY KEY (space_id, channel_id, seq),
    FOREIGN KEY (space_id, channel_id) REFERENCES channels(space_id, id)
);

INSERT INTO message_delivery (space_id, channel_id, seq, message_id)
SELECT space_id, channel_id, row_number() OVER (PARTITION BY space_id, channel_id ORDER BY received_at, id), id FROM messages;

INSERT INTO channel_message_cursors (space_id, channel_id, last_seq)
SELECT space_id, channel_id, max(seq) FROM message_delivery GROUP BY space_id, channel_id;
