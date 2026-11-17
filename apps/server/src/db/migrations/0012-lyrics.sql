-- Shared immutable texts. Editing a track replaces only its binding, never a sibling's lyrics.
CREATE TABLE lyric_documents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  digest text NOT NULL UNIQUE,
  body text NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 131072)
);
CREATE TABLE track_lyrics (
  track_id bigint PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('saved','file','none')),
  lyric_id bigint REFERENCES lyric_documents(id),
  filename text,
  CHECK ((mode='saved') = (lyric_id IS NOT NULL)),
  CHECK ((mode='file') = (filename IS NOT NULL))
);
