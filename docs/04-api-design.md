# OpenMusic 设计文档 —— 第一方 API 设计

Base path：`/api/v1`。实现载体：`@effect/platform` **HttpApi DSL**（Effect Schema 定义 request/response，`/api/docs` 自动生成 OpenAPI 文档页）。

## 1. 通用约定

- **格式**：JSON（UTF-8）。`/api/v1/*` 的错误体是带标签的结构化对象（Effect HttpApi typed error 序列化）：404 `{"_tag":"NotFound","entity":"playlist","id":"9"}`、403 `{"_tag":"Forbidden","message":"not owner"}`、401 `{"_tag":"Unauthorized","message":"no session"}`；各端点的具体形状以运行时 `/api/docs`（OpenAPI）为准。参数/负载解码失败由框架统一回 400；语义非法（handler 抛 `BadRequest`）为 422。media/SSE 等手写低层路由例外，使用 `{"error":{"code":…,"message":…}}` 形状。HTTP 状态码语义化（401/403/404/409/422/500）
- **认证**：`om_session` HttpOnly Cookie（见 02-architecture §4.1）。除 `/auth/login`、`/system/*` 外全部需要登录
- **权限**：`admin` 角色标注 🔒；普通用户只能操作自己的收藏/播放列表/记录，浏览曲库全员可用
- **分页**：`?limit=20&offset=0`（limit ≤ 500），响应统一 `{ items: T[], total: number, offset, limit }`
- **排序**：`?sort=field` / `?sort=-field`（- 前缀降序），每个 list 端点声明可用字段白名单
- **时间**：ISO 8601 UTC 字符串
- **ID**：JSON 中为字符串（与 Subsonic 层一致），DB 内 bigint

## 2. 资源与端点

**歌词（按物理曲目 ID，不按歌名）**：`GET /api/v1/tracks/:id/lyrics` 返回 `trackId,mode,source,filename,lyricsId,synced,lines:[{startMs,text}]`。无词时返回空列表，纯文本的 startMs 为 null。打开歌词时按需读取，不扫描目录。默认同目录同名 `.lrc` 优先，然后读文件内嵌标签。CUE 分轨不自动继承整轨歌词，可逐段手工绑定。

| 写接口（管理员或该版本导入者） | JSON 示例 | 作用 |
|---|---|---|
| `PUT /api/v1/tracks/:id/lyrics` | `{"text":"[00:01.20]第一行"}` | 保存 LRC 或纯文本，返回可复用的 `lyricsId`，并仅替换当前版本的绑定 |
| `PUT /api/v1/tracks/:id/lyrics/binding` | `{"mode":"saved","lyricsId":"17"}` | 绑定既有歌词文档 |
| 同上 | `{"mode":"file","filename":"伴奏版.lrc"}` | 明确绑定同目录的另一份 `.lrc`；不接受子路径或符号链接 |
| 同上 | `{"mode":"none"}` / `{"mode":"auto"}` | 不使用任何歌词 / 恢复同名 LRC、内嵌歌词的自动选择 |

这些操作只写数据库，不改音乐文件或原始 `.lrc`。Web/Android 全屏播放器点「歌词」查看；纯文本不伪造时间戳。

### 2.1 auth

| Method | Path | 说明 |
|--------|------|------|
| POST | `/auth/login` | `{username, password}` → 设置 cookie，返回当前用户 |
| POST | `/auth/logout` | 删除会话 |
| GET | `/auth/me` | 当前用户（未登录 401） |

`User`：`{ id, username, isAdmin, createdAt, lastSeenAt, transcodeProfile? }`

### 2.2 users 🔒

| Method | Path | 说明 |
|--------|------|------|
| GET | `/users` | 列表（分页） |
| POST | `/users` | 创建：`{username, password, isAdmin?}` |
| PATCH | `/users/:id` | 改密码 / 改角色 |
| DELETE | `/users/:id` | 删除（连带其所有数据） |

### 2.3 music-folders

| Method | Path | 说明 |
|--------|------|------|
| GET | `/music-folders` | 列表（含 lastScanAt） |
| POST | `/music-folders` 🔒 | `{path, name}`（服务端校验存在且可读） |
| PATCH | `/music-folders/:id` 🔒 | 改名 |
| DELETE | `/music-folders/:id` 🔒 | 删除（连带其 tracks 级联） |
| POST | `/library/scan` 🔒 | 触发扫描（幂等：进行中返回 409 `scan_in_progress`）；`?force=true` 跳过 mtime/size 增量基线全量重解析（归组规则升级后修存量） |
| DELETE | `/library/scan` 🔒 | 取消进行中的扫描（幂等）：interrupt 扫描 Fiber，已完成批次保留，重扫增量续上 |
| GET | `/library/scan-status` | `{state: idle\|scanning, phase?: walking\|indexing, total, processed, startedAt, lastScanAt, errors[]}`（登录即可轮询；phase 只在 scanning 时出现——walking=遍历磁盘（total 随发现增长），indexing=解析入库；errors 封顶 100 条） |

### 2.4 browse

| Method | Path | 说明 |
|--------|------|------|
| GET | `/artists` | 分页列表；`sort` ∈ name, albumCount, createdAt；过滤 `?starred=true&name=` |
| GET | `/artists/:id` | 详情 + 简要统计（albumCount / trackCount / duration） |
| GET | `/artists/:id/albums` | 该艺人专辑列表 |
| GET | `/artists/:id/top-tracks` | 按播放次数排序的 top 10 |
| GET | `/albums` | `sort` ∈ name, artist, year, createdAt, duration, random；过滤 `?artistId=&year=&genre=&starred=` |
| GET | `/albums/:id` | 详情（含 trackCount/duration） |
| GET | `/albums/:id/tracks` | 曲目列表（disc/track 排序） |
| GET | `/tracks` | `sort` ∈ title, artist, album, createdAt, playCount, random；过滤 `?albumId=&artistId=&genre=&starred=` |
| GET | `/tracks/:id` | 详情 |
| GET | `/tracks/:id/versions` | 该槽位（专辑+碟+归一标题）全部物理副本，canonical 首位，带 `path`（版本切换，docs/03 §2.5） |
| GET | `/genres` | `[{name, albumCount, trackCount}]` |
| GET | `/random` | `?count=20&size=` 随机曲目/专辑（供"随机播放"入口） |

`Track` 响应（shared Schema，前端/Subsonic 层共用子集）：

```jsonc
{
  "id": "123", "title": "...", "artist": {"id": "1", "name": "..."},
  "album": {"id": "9", "name": "...", "year": 2021},
  "disc": 1, "track": 3, "duration": 245,
  "bitrate": 961, "sampleRate": 44100, "channels": 2,
  "format": "audio/flac", "codec": "flac", "size": 29530000,
  "starred": "2026-09-14T...", "userRating": 4, "playCount": 12,
  "hasCoverArt": true, "createdAt": "..."
}
```

### 2.5 search

| Method | Path | 说明 |
|--------|------|------|
| GET | `/search?q=&type=all|artist|album|track&limit=&offset=` | 三路 trigram 搜索，`type=all` 返回 `{artists, albums, tracks}` 各取前 N；空 `q` 返回空集 |

P2：同一端点增加 `mode=semantic`（pgvector 召回），形状不变。

### 2.6 favorites & ratings（annotation）

| Method | Path | 说明 |
|--------|------|------|
| PUT | `/favorites/:type(artists\|albums\|tracks)/:id` | 收藏（幂等） |
| DELETE | `/favorites/:type/:id` | 取消收藏 |
| GET | `/favorites?type=&limit=&offset=` | 收藏列表（带分页） |
| PUT | `/ratings/:type/:id` | `{rating: 0-5}`（0 = 清除） |

### 2.7 playlists

| Method | Path | 说明 |
|--------|------|------|
| GET | `/playlists` | 自己的 + is_public 的他人列表 |
| POST | `/playlists` | `{name, comment?, isPublic?}` |
| GET | `/playlists/:id` | 详情（owner 可见或 public） |
| PATCH | `/playlists/:id` | 改名/注释/公开性（owner） |
| DELETE | `/playlists/:id` | 删除（owner） |
| GET | `/playlists/:id/tracks` | 有序曲目（分页） |
| POST | `/playlists/:id/tracks` | `{trackIds: []}` 追加到末尾 |
| PATCH | `/playlists/:id/tracks` | `{order: [trackId...]}` 整体重排（owner） |
| DELETE | `/playlists/:id/tracks/:position` | 按位置移除 |

### 2.8 plays（scrobble / 历史 / 统计）

| Method | Path | 说明 |
|--------|------|------|
| POST | `/plays/:trackId` | 上报一次播放；payload `{listenedSeconds?: int}` 为客户端**实测收听秒数**（缺省/未知不传，存 null，统计按曲目时长兜底）。now-playing 不持久，MVP 由前端本地展示 |
| GET | `/plays/recent?limit=20&offset=20` | 自己的逐次播放记录；返回数组。`limit` 默认 50，`offset` 默认 0；越过末尾返回 `[]`。条目 `{track, title, artistName, albumName, durationSeconds, playedAt}`；`track: null` 表示已不在库，保留打点快照（docs/03 §2.8）。 |
| GET | `/plays/recent?distinct=track&limit=20&offset=20` | 每个物理曲目 ID 只取最近一次，按播放时间倒序（同时间按播放记录 ID 倒序），再跳过前 20 首取下一页。不同版本不按歌名合并；已删除曲目沿用曲名、艺人、专辑、时长快照去重。每次请求读取当前历史，期间新增播放会使偏移位置移动。 |
| GET | `/plays/most-played?type=track\|album\|artist&period=all\|month\|year&limit=` | 自己的最常播放；返回带 `kind` 标签的联合条目（track/album/artist 摘要 + playCount + listenedSeconds）；track 型过滤墓碑行；album/artist 型排除兜底身份（Unknown Album/Unknown Artist，见 docs/03 §2.8）；归因见 docs/03 §2.8 |
| GET | `/plays/summary` | 听歌汇总（自己）：`{plays, tracks, listenedSeconds}`（listened_seconds 为 null 的按事件行快照时长估算；曲目删除不回退） |

Scrobble 有效性由**客户端**判断（Feishin/Subsonic 客户端已有规则：>50% 或 >4 分钟才发 submission），服务端不重复判定，只去重：以本次播放时间为中心 ±10 秒内同曲目重复上报不落库（写入处 guard，见 docs/03 §2.8）。

### 2.9 media

| Method | Path | 说明 |
|--------|------|------|
| GET | `/tracks/:id/stream?format=&maxBitRate=&timeOffset=` | 音频流（直传含 Range；转码规则见 02 §6），`Accept-Ranges` 对直传生效；`timeOffset`（秒）= 断点续播：ffmpeg 输入端 seek，raw 走流拷贝（mp3/flac/aac/vorbis/opus/wav，其余转码 mp3 兜底），不读不写转码缓存、忽略 Range。**CUE 虚拟曲**（is_virtual，docs/03 §2.9）恒经 ffmpeg：实际起点 = `offset_ms/1000 + timeOffset`，输出侧 `-t` 卡分段终点（客户端 seek/ended 语义与普通曲完全一致） |
| GET | `/tracks/:id/download` | 原文件直传，`Content-Disposition: attachment` |
| GET | `/covers/:id` | 封面图；id 形如 `al-9` / `ar-1` / `pl-3`；`?size=`（P1 缩放，MVP 原图 + Cache-Control 长缓存，ETag = cover 指纹） |

流端点响应头：`Content-Type`；直传时 `Content-Length` + `Accept-Ranges: bytes`；转码时 chunked。不设自定义时长头——播放时长走 API 元数据的 `durationSeconds`。

### 2.10 system

| Method | Path | 说明 |
|--------|------|------|
| GET | `/system/health` | `{status, version, db: ok}`（免认证） |
| GET | `/system/version` | 版本信息（免认证） |

### 2.11 agent 🔒（A1，docs/08）

`/admin/agent/*` 另需管理员身份（401/403/未启用 503）。`GET /admin/agent/settings` 返回当前 music 模型、可选模型、供应商连接摘要；`POST /admin/agent/settings` 接受 `model`、`custom`、`key`、`activate`、`disconnect` 五种受限操作，不接受任意 SDK 配置。`POST /admin/agent/console` 发起官方设备授权，`GET` / `DELETE /admin/agent/console/:id` 查询/取消。模型接入凭据不进入响应或会话 SSE。

`AGENT_ENABLED=false`（默认）时全部端点 503。会话归属：`agent_sessions` 表（docs/03 §2.10），非属主与不存在同回 404。

| Method | Path | 说明 |
|--------|------|------|
| POST | `/agent/sessions` | 建会话（payload `{title?}`；内嵌宿主创建 + 归属登记），返回 `{id, title, createdAt}` |
| GET | `/agent/sessions` | 自己的会话列表（最近 50）。`title` 包含宿主已生成的标题，实时标题变更另经 SSE 的 `session.renamed`（sessionID/title）通知属主 |
| GET | `/agent/sessions/:id/messages` | user/assistant 消息，保留 `text`；assistant 另带有序 `parts`：文本（ordinal/text）、工具（id/name/status/calls，内层仅 name/status），不含推理或工具原始输入输出 |
| POST | `/agent/sessions/:id/prompt` | 发消息（payload `{text}`）→ 204，异步生成；经 SSE 或 GET messages 拉取 |
| POST | `/agent/sessions/:id/interrupt` | 打断生成 → 204 |
| GET | `/agent/events`（SSE，低层路由） | 仅推送登录用户所属会话：`message.delta` / `message.snapshot`（sessionID/messageID/ordinal + append 或 text）、播放确认 `client-action`、`raw` 包装的文本开始、工具和执行状态。未登录 401；不接受客户端指定的属主，不透传原始工具入参/输出或全局事件 |

## 3. 端点与 Subsonic 层的复用关系

所有媒体/域逻辑都在 service 层实现；第一方与 Subsonic 两个 HTTP 层各自薄封装：

| 能力 | 第一方端点 | Subsonic 端点 |
|------|-----------|---------------|
| 流 | `/tracks/:id/stream` | `stream.view` / `download.view` |
| 封面 | `/covers/:id` | `getCoverArt.view` |
| 收藏 | `/favorites/*` | `star.view` / `unstar.view` |
| 评分 | `/ratings/*` | `setRating.view` |
| 播放列表 | `/playlists/*` | `getPlaylists.view` 等 5 个 |
| scrobble | `/plays/*` | `scrobble.view` / `reportPlayback.view`(P1) |
| 扫描 | `/library/*` | `startScan.view` / `getScanStatus.view` |

## 4. 版本化策略

- 破坏性变更时引入 `/api/v2` 并保留 v1 一段时间；v1 内只做向后兼容的加法（新字段、新端点）
- OpenAPI 文档 `/api/docs` 始终反映当前实现，作为前后端契约的唯一事实源
# YouTube 媒体导入（第一方 API）

**移除单个导入版本**（下列路径相对于 `/api/v1/imports/youtube`）：

- `DELETE /tracks/:id/library-entry`：移出共享曲库和歌单，保留原文件；按曲库根 ID + 相对路径持久排除，增量/强制扫描都不捡回。
- `POST /tracks/:id/file-deletion-requests`：只申请删除原件，返回 `reviewPath`，无文件或曲库变动。本人登录后打开 `/review-deletion/<requestId>`，网页 `POST /file-deletion-requests/:key/review` 取得文件详情和一次性确认凭据；核对并输入完整文件名后 `POST /file-deletion-requests/:key/confirm {token,filename}`。仅成功提交数据库事务后清除暂存原件。`DELETE /file-deletion-requests/:key` 取消。申请 5 分钟失效，重启即作废；变更的文件、曲目或权限须重新核对。
- 默认仅导入者/管理员可以操作；无归属的老 MP3 仅管理员且需核验来源标签。只操作传入的物理 `trackId`，不按视频 ID 或歌名批量删除；不删除收听历史。MCP 只有 `youtube.remove_from_library` 和 `youtube.request_file_deletion`，没有确认/兑现文件删除的工具。

`POST /requests` 和 MCP `youtube.start_import` 共用可选 `format`：省略或 `original` = 最佳可用 Opus/AAC 源音频（需要时只换容器，保存 `.opus` 或 `.m4a`）；`mp3` = 显式转换 MP3；`video` = 保留 H.264 画面和 AAC 音频的 `.mp4`（至多 1080p，仍受单文件 96 MiB 限制）。不支持任意 yt-dlp 参数，不静默改为其他模式。整个播放列表使用同一模式。终态结果含 `format` 和 `files: [{trackId,name}]`，同视频不同模式可共存；旧 MP3 不会被重写，也不会阻止导入原编码音频。原文件下载与 `stream?format=raw` 可用于取回视频，音乐客户端不因此新增视频播放器。

以下路径相对于 `/api/v1/imports/youtube`。单视频 `POST /requests` 可带 `metadata`：`title/artist/album/albumArtist/genre/trackNumber/discNumber/cover`。返回 `warnings` 表示缺少缩略图或上传日等非致命问题。`GET /catalog?q=…&country=JP` 查询发行候选；`GET /tracks/:id/metadata` 查看来源、上传日期与标签，`PATCH /tracks/:id/metadata` 以导入者或管理员权限更新同一曲目。示例：`{"cover":"youtube"}` 恢复视频封面；`cover` 也可为支持的 Apple/YouTube 图片 CDN HTTPS URL，或 `data:image/jpeg;base64,…`（也支持 PNG/WebP；原图上限 4 MiB / 1600 万像素，嵌入最大 1200px JPEG）。不接受本地路径、任意远程主机或跳转地址。

`/api/v1/imports/youtube` 以下端点都需要用户 cookie。`POST /search {query}` 返回至多 5 个 `{title,channel,url}`；`POST /requests {url,folderId,subdirectory?,sessionID?}` 在本次请求中等待导入结束，返回 `state`（`done`、`partial` 或 `failed`）、目录、计数、`failures` 与可播放的 `trackIds`，不返回运行中句柄。相同用户、会话、URL 和目标的并发请求共享终态结果。没有任务列表或清理接口。目录列表来自 `GET /api/v1/music-folders`；只有管理员可以增删改曲库根目录。
# 网易云音乐导入（第一方 API）

**合规边界**：本功能只做「导入网易云链接/搜索结果」，明文公开接口全部直连 music.163.com，仓库不含任何加密实现（weapi/eapi），不接触用户 cookie，不做灰色歌曲换源，也不支持任何第三方实例后端。VIP/付费歌曲有完整元数据与 `vip` 标记，导入时**明确跳过**。

## 1. 端点（`/api/v1/imports/netease`，均需用户 cookie）

- `GET /search?q=<关键词>`：返回至多 5 个 `{title,artist,album,songId,url,vip}`。`vip:true` 即 `fee∈{1,4}`（VIP/付费）。
- `POST /requests {url,folderId,subdirectory?,sessionID?}`：**同步等终态**，返回 `NeteaseImportResult`：

```json
{ "url": "https://music.163.com/song?id=5264842", "kind": "song", "state": "done",
  "total": 1, "imported": 1, "skipped": 0, "failed": 0, "destination": "/music/网易云",
  "trackIds": [42], "files": [{ "trackId": 42, "name": "Netease-5264842.mp3" }],
  "failures": [{ "songId": "2606227455", "reason": "VIP/付费歌曲需要会员账号，未导入。" }],
  "warnings": [{ "songId": "5264842", "message": "未取得歌词。" }] }
```

`kind` 为 `song/playlist/album/artist`；每首实际音质档位存于 `netease_imports.quality`（匿名来源为 MP3 ≤320k）。Single-flight 与 YouTube 相同：每用户 1 并发、全站 2；搜索全站 4；相同用户/会话/URL/目标的并发请求共享终态；无任务列表。

## 2. 链接解析与规模

只接受 music.163.com 的 `song/playlist/album/artist`（含 `#/song`、`y.` 前缀、`m/song/<id>` 变体；ID 为 1–20 位数字），**规范化重建后才访问**，绝不透传用户原始 URL；其他 host/路径一律 422。歌单/专辑最多 25 首：超限整组 422（歌单请拆分、专辑请逐首）；歌手热门固定取前 25 首（`singer` 来源本身只有热门 ~50 首）并记 warning。逐首独立处理，一首失败继续下一首，`failures` 按 `songId` 逐条说明。

## 3. 匿名音源与预检

- **yt-dlp 匿名下载（唯一后端）**：`-f bestaudio/best`（netease 匿名只有 standard/higher/exhigh 三档 MP3，绝不套 YouTube 的 opus/aac 白名单），`--match-filters "!is_live & duration <= 1800"`、`--max-filesize 96M`。元数据与预检走明文 API（`/api/search/get`、`/api/song/detail`、`/api/song/lyric`，完整桌面 Chrome UA；专辑走 `/api/album/{id}` + Referer，该接口对匿名请求有间歇性 -462 风控，失败即报「暂时无法读取专辑」）。`NETEASE_REAL_IP` 可选伪装出口 IPv4（明文 `X-Real-IP` 头 / yt-dlp `--xff`）。匿名上限如实告知：约 320k MP3；海外直连对部分曲库有地区差异。
- **预检**：批量 `song/detail` 取 `fee` 与时长。`fee∈{1,4}` 的 VIP/付费歌**无条件跳过**并记 `failures`（「VIP/付费歌曲需要会员账号，未导入。」）——不发起下载。下架/地区限制由「详情缺失」与下载失败兜底。

## 4. VIP 试听防护（双保险，不依赖预检）

网易云 VIP 歌可能**静默**返回 30 秒 128k 试听片段（yt-dlp exit 0 无警告）。每次下载后用 ffprobe 核对实际时长 vs 预期时长（容差 `max(2 秒, 预期 1%)`）；不符即删除临时文件、记 `failures`（如「疑似试听片段：实际 30.0 秒 / 预期 281.4 秒，已丢弃未入库」），绝不入库。预期时长缺失也拒绝入库（无法校验）。即使上游接口日后放宽 fee 标记，这道时长校验也不依赖预检独立生效。

## 5. 入库内容与歌词

文件命名 `Netease-<songId>.mp3|flac`（`netease_imports` 溯源：song_id/导入者/实际音质档位）；同目录同 ID 已有文件记 `skipped` 不覆盖。元数据（曲名/歌手/专辑/发行日/封面）来自网易云本身并内嵌文件标签，发行日即专辑发行日期（作为专辑年份，不同于 YouTube 的上传日）；封面仅接受 `*.music.126.net`（http 归一为 https，实际字节可能是 PNG 伪装 .jpg，写入端已兼容）。无 iTunes 目录补全。歌词：导入成功后原文+翻译（若有，等时间戳合并为「原文/译文」双行）自动存入共享歌词体系（0012 表，digest 去重）；失败仅记 `warnings`，不阻断导入。
# 助手消息投递

`POST /api/v1/agent/sessions/:id/prompt` 可选 `delivery: "steer" | "queue"`。省略为 `steer`，允许在 busy 时提交，成功仍返回 204（已受理，不表示已投递）。`steer` 在可接收输入的步骤补充当前任务，不中断正在执行的工具；`queue` 留待后续轮次。`GET .../:id/inbox` 返回 `{busy,items:[{id,text,delivery}]}`，只投影本会话的待投递用户文本；`PATCH .../:id/inbox/:item {delivery}` 改方式，`DELETE .../:id/inbox/:item` 撤回。所有操作核验会话属主。网页 Enter 默认补充，忙碌时可点排队或 Alt+Enter；只在宿主投递后写入消息时间线，SSE 断线重连后从宿主恢复。
