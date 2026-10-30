ALTER TABLE sessions ADD COLUMN progress smallint CHECK (progress BETWEEN 0 AND 100);
