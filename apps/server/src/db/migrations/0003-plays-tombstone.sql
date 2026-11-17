-- 播放事件日志不可变化（docs/03 §2.7 / docs/04 §2.8 墓碑设计）
--
-- 动机：曲目删除（目录注销级联 / 扫描清理）此前连带抹掉收听史——
-- 统计回退、最近播放断档，对后续 AI 统计/推荐是相关性缺失（按目录批量丢数据）。
-- 设计原则：事实不可变，视图可再生。曲目死掉后，事件行本身就是叙事与统计身份。
--
-- 1) FK 改 SET NULL：曲目删除只解引用，播放事件永久保留
ALTER TABLE plays DROP CONSTRAINT plays_track_id_fkey;
ALTER TABLE plays ALTER COLUMN track_id DROP NOT NULL;
ALTER TABLE plays
  ADD CONSTRAINT plays_track_id_fkey
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE SET NULL;

-- 2) 打点快照：曲目死后的叙事（title/名字/时长）+ 稳定分析身份。
--    artist_id/album_id 采自自然键 upsert 的行——跨「删目录 → 重扫」周期保持同一 id，
--    艺人/专辑级统计因此天然免疫曲目生死。
ALTER TABLE plays
  ADD COLUMN title text,
  ADD COLUMN artist_name text,
  ADD COLUMN album_name text,
  ADD COLUMN duration_seconds bigint,
  ADD COLUMN artist_id bigint,
  ADD COLUMN album_id bigint;

-- 3) 存量回填：从现行曲目行定格快照
UPDATE plays p SET
  title = t.title,
  artist_name = ar.name,
  album_name = al.name,
  duration_seconds = t.duration_seconds,
  artist_id = ar.id,
  album_id = al.id
FROM tracks t
  JOIN albums al ON al.id = t.album_id
  JOIN artists ar ON ar.id = t.artist_id
WHERE p.track_id = t.id;
