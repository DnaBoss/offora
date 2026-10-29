ALTER TABLE messages ADD COLUMN reply_to text;
CREATE UNIQUE INDEX messages_space_channel_id ON messages (space_id, channel_id, id);
ALTER TABLE messages ADD CONSTRAINT messages_reply_same_channel FOREIGN KEY (space_id, channel_id, reply_to) REFERENCES messages(space_id, channel_id, id);
