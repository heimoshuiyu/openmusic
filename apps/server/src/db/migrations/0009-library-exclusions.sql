-- An explicit removal wins over both incremental and forced scans of this path.
CREATE TABLE library_exclusions (
  music_folder_id bigint NOT NULL REFERENCES music_folders(id) ON DELETE CASCADE,
  path text NOT NULL,
  PRIMARY KEY (music_folder_id, path)
);
