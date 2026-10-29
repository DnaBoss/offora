ALTER TABLE invitations ADD COLUMN agent_id text REFERENCES agents(id);
