-- 存量 track 收藏/评分治愈：归一到槽位 canonical 代表（docs/03 §2.5）。
-- 写路径已由 AnnotationRepo.canonicalizeTrackIds 归一，本迁移只搬历史行——
-- 非 canonical 的 track 注解先补写 canonical 行（冲突保留既有），再删旧行。
-- 曲目级收藏语义 = 「这首歌」而非「这个文件副本」：canonical 换人时星标自动跟随。

INSERT INTO annotations (user_id, item_type, item_id, starred_at, rating)
SELECT an.user_id, 'track', c.id, an.starred_at, an.rating
FROM annotations an
JOIN tracks t ON t.id = an.item_id
JOIN canonical_tracks c
  ON c.album_id = t.album_id AND c.disc = t.disc
 AND lower(btrim(c.title)) = lower(btrim(t.title))
WHERE an.item_type = 'track' AND c.id <> t.id
ON CONFLICT (user_id, item_type, item_id) DO NOTHING;

DELETE FROM annotations an
WHERE an.item_type = 'track'
  AND EXISTS (SELECT 1 FROM tracks t WHERE t.id = an.item_id)
  AND NOT EXISTS (SELECT 1 FROM canonical_tracks c WHERE c.id = an.item_id);
