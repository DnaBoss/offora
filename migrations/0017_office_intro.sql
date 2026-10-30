ALTER TABLE auto_offices
    ADD COLUMN name text,
    ADD COLUMN goal text,
    ADD COLUMN computer text,
    ADD COLUMN environment text,
    ADD COLUMN repo_label text;

CREATE TABLE auto_office_repos (
    computer_hash bytea NOT NULL REFERENCES auto_offices(key_hash) ON DELETE CASCADE,
    repo_key text NOT NULL,
    PRIMARY KEY (computer_hash, repo_key)
);
