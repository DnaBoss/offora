ALTER TABLE socket_tickets ADD COLUMN stream text NOT NULL DEFAULT 'messages' CHECK (stream IN ('messages', 'events'));
