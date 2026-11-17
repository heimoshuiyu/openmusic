-- 标准版本视图（docs/03 §2.5）：同一专辑的多份物理副本（不同来源/音质/版本的
-- 重复拷贝是本库主形态——5,387/5,467 张专辑有重复槽位）在浏览面只保留一份最优拷贝。
--
-- 槽位键 = (album_id, disc, lower(btrim(title)))：同名同碟视为同一首歌的多个版本；
-- 豪华版新增曲目（新标题）自然成为新槽位可见，重排序/重灌版仍正确合并。
-- 选择规则（全序确定性）：无损容器优先 → 采样率高 → 码率高 → 路径短 → id 小。
--
-- 只影响浏览/搜索/随机的取数口径——物理行一个不删：播放任意副本、播放列表引用、
-- plays 打点、封面样本提取全部照旧走 tracks 表。版本切换 UI 靠 version_count 挂钩。

CREATE OR REPLACE VIEW canonical_tracks AS
SELECT s.id, s.music_folder_id, s.album_id, s.artist_id, s.disc, s.track_no, s.title,
       s.duration_seconds, s.bitrate_kbps, s.sample_rate_hz, s.channels, s.format, s.codec,
       s.size_bytes, s.path, s.mtime_ms, s.has_embedded_cover, s.created_at, s.updated_at,
       s.offset_ms, s.is_virtual, s.version_count
FROM (
  SELECT t.*,
         row_number() OVER (
           PARTITION BY t.album_id, t.disc, lower(btrim(t.title))
           ORDER BY (t.codec IN ('flac', 'alac', 'wv', 'ape', 'aiff', 'dsf', 'wav')) DESC,
                    t.sample_rate_hz DESC,
                    t.bitrate_kbps DESC,
                    length(t.path) ASC,
                    t.id ASC
         ) AS rn,
         count(*) OVER (PARTITION BY t.album_id, t.disc, lower(btrim(t.title))) AS version_count
  FROM tracks t
) s
WHERE s.rn = 1;

COMMENT ON VIEW canonical_tracks IS
  '浏览面标准版本：每 (album, disc, title) 槽位一份最优拷贝 + version_count；物理行见 tracks';
