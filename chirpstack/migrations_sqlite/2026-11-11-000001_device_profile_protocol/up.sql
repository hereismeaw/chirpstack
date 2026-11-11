ALTER TABLE device_profile ADD COLUMN protocol SMALLINT NOT NULL DEFAULT 0 CHECK (protocol IN (0, 1));
