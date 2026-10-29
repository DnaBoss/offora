ALTER TABLE agents ADD COLUMN is_observer boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX agents_owner_observer ON agents(owner_id) WHERE is_observer;
ALTER TABLE agent_credentials ADD COLUMN owner_credential_id text REFERENCES owner_credentials(id);
ALTER TABLE sessions ADD COLUMN is_observer boolean NOT NULL DEFAULT false;

CREATE FUNCTION revoke_owner_observers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.revoked_at IS NOT NULL THEN
        UPDATE agent_credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE owner_credential_id=NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER revoke_owner_observers_after_update
AFTER UPDATE OF revoked_at ON owner_credentials
FOR EACH ROW EXECUTE FUNCTION revoke_owner_observers();
