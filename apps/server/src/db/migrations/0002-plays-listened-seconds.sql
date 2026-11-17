-- 播放事件补充实测收听秒数（docs/03 §2.7 / docs/04 §2.8）
-- null = 客户端未上报（Subsonic scrobble 协议无此字段），
-- 统计时 coalesce(listened_seconds, tracks.duration_seconds) 按整曲时长估算。
ALTER TABLE plays ADD COLUMN listened_seconds bigint;
