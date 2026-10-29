BEGIN;
INSERT INTO owners VALUES ('o1', 'one'), ('o2', 'two');
INSERT INTO spaces VALUES ('s1', 'o1', 'one'), ('s2', 'o2', 'two');
INSERT INTO channels VALUES ('c1', 's1', 'one'), ('c2', 's2', 'two');
INSERT INTO agents VALUES ('a1', 'o1', 'one');
INSERT INTO invitations (id, space_id, token_hash, expires_at, max_uses) VALUES ('i1', 's1', decode('01', 'hex'), now() + interval '1 hour', 1);
INSERT INTO invitation_channels (space_id, invitation_id, channel_id, can_read, can_send) VALUES ('s1', 'i1', 'c1', true, true);
INSERT INTO agent_credentials (id, agent_id, space_id, token_hash) VALUES ('k1', 'a1', 's1', decode('02', 'hex'));
INSERT INTO channel_grants (space_id, credential_id, channel_id, can_read, can_send) VALUES ('s1', 'k1', 'c1', true, true);
INSERT INTO sessions (id, space_id, credential_id, token_hash, role, code, model) VALUES ('t1', 's1', 'k1', decode('03', 'hex'), 'developer', 'D1', 'test');
INSERT INTO messages (id, space_id, channel_id, session_id, client_message_id, payload) VALUES ('m1', 's1', 'c1', 't1', 'request-1', '{"text":"hello"}');
DO $$
BEGIN
    BEGIN
        INSERT INTO channel_grants (space_id, credential_id, channel_id) VALUES ('s1', 'k1', 'c2');
        RAISE EXCEPTION 'cross-space grant was accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO messages (id, space_id, channel_id, session_id, client_message_id, payload) VALUES ('m2', 's1', 'c2', 't1', 'request-2', '{}');
        RAISE EXCEPTION 'cross-space message was accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO messages (id, space_id, channel_id, session_id, client_message_id, payload) VALUES ('m3', 's1', 'c1', 't1', 'request-1', '{}');
        RAISE EXCEPTION 'duplicate request was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
        UPDATE invitations SET uses = 2 WHERE id = 'i1';
        RAISE EXCEPTION 'invitation overuse was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO sessions (id, space_id, credential_id, token_hash, role, code, model) VALUES ('t2', 's1', 'k1', decode('04', 'hex'), 'developer', 'D1', 'test');
        RAISE EXCEPTION 'active duplicate code was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
END $$;
UPDATE sessions SET left_at = now() WHERE id = 't1';
INSERT INTO sessions (id, space_id, credential_id, token_hash, role, code, model) VALUES ('t2', 's1', 'k1', decode('04', 'hex'), 'developer', 'D1', 'test');
ROLLBACK;
