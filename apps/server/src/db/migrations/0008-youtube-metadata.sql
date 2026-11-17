-- Track-specific provenance: a video upload date is NOT the album's release year.
CREATE TABLE youtube_imports (
  track_id bigint PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  video_id text NOT NULL,
  imported_by bigint REFERENCES users(id) ON DELETE SET NULL,
  upload_date date,
  cover_source text,
  genre text
);
