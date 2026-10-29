ALTER TABLE messages ADD COLUMN conversation_id text;
ALTER TABLE messages ADD CONSTRAINT messages_conversation_same_channel FOREIGN KEY (space_id, channel_id, conversation_id) REFERENCES conversations(space_id, channel_id, id);
CREATE INDEX messages_conversation_history ON messages (space_id, channel_id, conversation_id, received_at, id);
