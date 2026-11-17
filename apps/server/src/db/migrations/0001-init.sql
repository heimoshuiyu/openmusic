-- 0001-init: 全量建表（见 docs/03-data-model.md）
-- 注意：不使用含 ";" 的字符串字面量/函数体（迁移加载器按 ";" 切分语句）

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE users (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username            text NOT NULL UNIQUE,
  password_hash       text NOT NULL,
  -- hex(md5(password))，Subsonic token 认证用（docs/03 §2.6）
  subsonic_token_seed text NOT NULL,
  is_admin            boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz
);

CREATE TABLE sessions (
  token      text PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_agent text
);

CREATE TABLE music_folders (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  path         text NOT NULL UNIQUE,
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_scan_at timestamptz
);

-- 名称归一化（NFKC + casefold）由应用侧写入前完成，
-- 索引只做 lower/btrim 兜底去重
CREATE TABLE artists (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL,
  sort_name   text,
  album_count bigint NOT NULL DEFAULT 0,
  track_count bigint NOT NULL DEFAULT 0,
  cover_file  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX artists_name_norm_idx ON artists (lower(btrim(name)));

CREATE TABLE albums (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  artist_id       bigint NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  name            text NOT NULL,
  sort_name       text,
  year            integer,
  genre           text,
  track_count     bigint NOT NULL DEFAULT 0,
  duration_seconds bigint NOT NULL DEFAULT 0,
  cover_file      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX albums_artist_name_idx ON albums (artist_id, lower(btrim(name)));

CREATE TABLE tracks (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  music_folder_id    bigint NOT NULL REFERENCES music_folders(id) ON DELETE CASCADE,
  album_id           bigint NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  artist_id          bigint NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  disc               integer NOT NULL DEFAULT 1,
  track_no           integer,
  title              text NOT NULL,
  duration_seconds   integer NOT NULL DEFAULT 0,
  bitrate_kbps       integer NOT NULL DEFAULT 0,
  sample_rate_hz     integer NOT NULL DEFAULT 0,
  channels           integer NOT NULL DEFAULT 0,
  format             text NOT NULL,
  codec              text NOT NULL,
  size_bytes         bigint NOT NULL,
  -- 相对 music_folder 根的路径（POSIX 分隔符）
  path               text NOT NULL,
  mtime_ms           bigint NOT NULL,
  has_embedded_cover boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tracks_folder_path_idx ON tracks (music_folder_id, path);

-- 用户维度的收藏/评分（多态关联，见 docs/03 §2.3）
CREATE TABLE annotations (
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type  text NOT NULL CHECK (item_type IN ('artist', 'album', 'track')),
  item_id    bigint NOT NULL,
  starred_at timestamptz,
  rating     integer CHECK (rating BETWEEN 0 AND 5),
  PRIMARY KEY (user_id, item_type, item_id)
);

CREATE INDEX annotations_user_starred_idx ON annotations (user_id) WHERE starred_at IS NOT NULL;

CREATE TABLE playlists (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             text NOT NULL,
  comment          text,
  is_public        boolean NOT NULL DEFAULT false,
  duration_seconds bigint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE playlist_tracks (
  playlist_id bigint NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position    integer NOT NULL,
  track_id    bigint NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (playlist_id, position)
);

CREATE TABLE plays (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id   bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id  bigint NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  played_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX plays_user_time_idx ON plays (user_id, played_at DESC);
CREATE INDEX plays_track_idx ON plays (track_id);

-- P1: 服务端播放队列（indexBasedQueue 扩展通告后启用）
CREATE TABLE play_queues (
  user_id       bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  items         jsonb NOT NULL DEFAULT '[]',
  current_index bigint NOT NULL DEFAULT 0,
  changed_at    timestamptz NOT NULL DEFAULT now()
);

-- 搜索（trigram，CJK 友好，见 docs/02 R2-4）
CREATE INDEX tracks_title_trgm ON tracks USING gin (title gin_trgm_ops);
CREATE INDEX albums_name_trgm  ON albums  USING gin (name gin_trgm_ops);
CREATE INDEX artists_name_trgm ON artists USING gin (name gin_trgm_ops);

-- 浏览排序
CREATE INDEX albums_artist_idx  ON albums (artist_id);
CREATE INDEX tracks_album_idx   ON tracks (album_id, disc, track_no);
CREATE INDEX tracks_artist_idx  ON tracks (artist_id);
