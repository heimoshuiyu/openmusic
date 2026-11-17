-- 0004: CUE 整轨虚拟分轨（docs/03 §2.9）
-- 虚拟曲目 = 指向物理镜像文件的一个 [offset, offset+duration) 分段：
--   is_virtual = true 时 path 为合成键（镜像相对路径 + "#" + 三位零填充轨号），
--   物理镜像文件本身不再生成 track 行（消失清理/幂等 upsert 全靠合成键工作）；
--   offset_ms = 分段起点（毫秒）；duration_seconds 存分段时长（非镜像全长）。
alter table tracks add column offset_ms bigint not null default 0;
alter table tracks add column is_virtual boolean not null default false;
