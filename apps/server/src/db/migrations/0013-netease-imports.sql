-- Netease import provenance (docs/04 网易云导入组): per physical track, the source song
-- and the delivered quality tier. Lyrics reuse the shared lyric tables (0012).
CREATE TABLE netease_imports (
  track_id bigint PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  song_id text NOT NULL,
  imported_by bigint REFERENCES users(id) ON DELETE SET NULL,
  quality text,
  created_at timestamptz NOT NULL DEFAULT now()
);
