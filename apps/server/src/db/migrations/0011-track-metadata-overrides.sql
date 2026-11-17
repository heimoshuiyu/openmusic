-- No backfill: a previously scanned tag is not evidence of an explicit override.
CREATE TABLE track_metadata_overrides (
  track_id bigint PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object')
);
