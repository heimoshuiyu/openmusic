# OpenMusic 设计文档 —— Subsonic 兼容层（面向 Feishin）

> 本文档基于 **Feishin 源码调研**（github.com/jeffvli/feishin，`src/renderer/api/subsonic/`、`src/shared/api/subsonic/`）。

## 1. Feishin 客户端行为结论（调研事实）

1. **请求形状**：`GET {serverUrl}/rest/{endpoint}.view?...&u=..&t=..&s=..&v=1.13.0&c=Feishin&f=json`
   - 全部带 `f=json`、`v=1.13.0`、`c=Feishin`
   - 认证二选一：token 模式（`t`=md5(password+salt) + `s`=salt，默认）或 legacy 模式（`p`=明文/hex 密码）
   - 若通告 `formPost` 扩展，会改用 POST + form body（我们不通告，走 query）
2. **能力探测流程**（登录时）：
   ```
   ping.view → 响应含 openSubsonic=true 且 serverVersion 存在？
     ├─ 否 → 纯 Subsonic 模式
     └─ 是 → getOpenSubsonicExtensions.view → 读取扩展名列表：
           transcoding / songLyrics / formPost / indexBasedQueue /
           playbackReport / topSongsByArtistId
           再探测 jukeboxControl(status) → 报错则禁用 jukebox
   ```
3. **不通告的扩展 Feishin 会自动回退**：
   - 不通告 `indexBasedQueue` → 播放队列仅存本地（不调 getPlayQueue/savePlayQueue）
   - 不通告 `songLyrics` → 不调 getLyricsBySongId
   - 不通告 `transcoding` → 不调 getTranscodeStream/getTranscodeDecision，转码走经典 `stream.view` 的 `format`/`maxBitRate` 参数
   - 不通告 `playbackReport` → 不调 reportPlayback
   - `jukeboxControl(status)` 返回 Subsonic 错误 → jukebox 功能隐藏

## 2. 我们的通告策略

`ping` 响应：

```json
{ "subsonic-response": {
    "status": "ok", "version": "1.16.1",
    "serverVersion": "0.1.0", "openSubsonic": true
} }
```

`getOpenSubsonicExtensions` 响应的扩展列表**随实现进度逐步追加**：

| 里程碑 | 通告扩展 |
|--------|----------|
| MVP | `[]`（空列表——合法，Feishin 全部走经典回退路径） |
| P1 | `songLyrics [1]`、`playbackReport [1]`、`indexBasedQueue [1]`、`transcoding [1]` |

## 3. 认证实现

请求参数（query）三选一验证：

| 模式 | 参数 | 验证 |
|------|------|------|
| token | `u`,`t`,`s` | 取用户 `subsonic_token_seed`（= hex(md5(password))，见 03 §2.7）→ `md5(seedBytes ++ salt) == t` |
| hex | `u`,`p=enc:<hex>` | hex 解码得 md5(password)，与 seed 比对 |
| plain | `u`,`p=<plain>` | `Bun.password.verify`（argon2） |

失败 → 标准错误 `code=40`（wrong username/password）且 HTTP 200。用户名不存在统一回 40（不区分提示）。`getUser.view` 作为登录探活端点，必须返回用户角色（`adminRole` 等，scrobblingEnabled 等 true）。

## 4. 响应序列化

- `f=json`（Feishin）：`Content-Type: application/json`，信封 `{"subsonic-response": {...}}`
- `f=xml`（其他客户端余量）：`fast-xml-parser` 构建，结构与 JSON 同源（单一内部响应对象 → 双序列化器）
- 无论业务成败，HTTP 状态一律 200（Subsonic 惯例），业务错误置于 `subsonic-response.status="failed"` + `error{code,message}`
- 字段类型坑：Feishin 的 zod schema 对多数数值字段做了 `z.union([string, number])` 容忍，但我们**统一输出正确类型**（数值字段输出数值、布尔输出布尔、可空字段缺省时直接省略键）
- 时间格式：`yyyy-MM-dd'T'HH:mm:ss.SSS'Z'`（Subsonic 惯例）

## 5. 端点清单（MVP 实现范围）

### 5.1 必须（Feishin 核心链路，37 个）

| 端点 | 用途（Feishin 场景） | 实现要点 |
|------|---------------------|----------|
| `ping` | 连通/登录探测 | §2 的响应 + extensions 信息 |
| `getUser` | 登录认证确认 | 角色/权限字段全 true（adminRole 按实际） |
| `getOpenSubsonicExtensions` | 能力协商 | §2 策略 |
| `getMusicFolders` | 文件夹模式浏览根 | music_folders 表 |
| `getIndexes` | 文件夹模式索引 | tracks.path 虚拟目录树的首层分组 |
| `getMusicDirectory` | 文件夹模式钻取 | 虚拟目录 + 文件；`isDir` 区分 |
| `getArtists` | ID3 艺人总览（按首字母分组） | artists 表按 name[0] 分组（CJK 归 `#` 分组） |
| `getArtist` | 艺人详情（含专辑列表） | |
| `getAlbum` | 专辑详情（含曲目） | disc/track 排序 |
| `getSong` | 单曲详情 | |
| `getAlbumList2` | 专辑分页列表 | type=random/newest/recent/frequent/recent → 映射我们的排序/聚合；size/offset 分页 |
| `getGenres` | 流派筛选 | |
| `getSongsByGenre` | 流派曲目 | |
| `getRandomSongs` | 随机播放 | size 参数 |
| `getStarred`（getStarred2 一并提供） | 收藏页 | annotations |
| `search3` | 搜索 | SearchService，`artistCount/albumCount/songCount/offsets` 参数 |
| `getArtistInfo2` | 艺人页附加信息 | 返回空 biography/外部链接（无刮削），similar artist 可选给同 genre 艺人 |
| `getAlbumInfo2` | 专辑页附加 | 空结构 |
| `getTopSongs` | 艺人 top 曲 | plays 聚合 |
| `getSimilarSongs(2)` | "相似播放" | 同艺人随机 + 同流派随机补足 count |
| `getPlaylists` | 播放列表列表 | 自己的 + public |
| `getPlaylist` | 播放列表详情（含曲目） | |
| `createPlaylist` | 新建 / 整体替换 | `playlistId` 缺省=新建；带 songId=全量替换。仅限本人列表（非属主回 code 50） |
| `updatePlaylist` | 增删改 | name/comment/public/songIdToAdd/songIndexToRemove；仅限本人列表（非属主回 code 50） |
| `deletePlaylist` | 删除 | 仅限本人列表（非属主回 code 50） |
| `star` / `unstar` | 收藏切换 | id/albumId/artistId 三类参数 |
| `setRating` | 评分 | id + rating 0-5 |
| `scrobble` | 播放上报 | id + time?（规范为**毫秒**，兼容秒值）；`submission=false` 仅记 now-playing（MVP 内存）；10s 去重见 docs/03 §2.8 |
| `stream` | 播放流 | 复用 StreamService；`maxBitRate`/`format`/`timeOffset`（映射到第一方断点续播）；Range 直传 |
| `download` | 原文件 | |
| `getCoverArt` | 封面 | `al-/tr-/ar-/pl-` 前缀 ID（song 的 coverArt 为 `tr-`：自身内嵌 → 专辑链兜底）；`size=` 缩放 P1 |
| `getScanStatus` | 扫描状态 | scanning/count |
| `startScan` | 触发扫描 | 管理员；复用扫描单飞锁 |
| `getInternetRadioStations` | 电台列表入口 | MVP 返回空列表（合法，UI 隐藏/空态） |
| `getLyrics`（经典） | 歌词回退 | MVP 返回空 `<lyrics artist= title=/>` 结构 |

### 5.2 明确不实现（Feishin 仅在对应扩展通告后才调用）

`getLyricsBySongId`、`reportPlayback`、`getTranscodeStream`、`getTranscodeDecision`、`getPlayQueueByIndex`、`savePlayQueueByIndex`、`jukeboxControl`（返回错误码 0 使 Feishin 禁用 jukebox）

调用到未实现端点时统一返回 `code=0 message="not implemented"`（错误兜底 handler），保证客户端不崩溃。

### 5.3 明确拒绝实现

`getChatMessages`/`addChatMessage`、`getVideos`/`video`*、`getPodcasts`/`podcast`*、`getBookmarks`/`bookmarks`*（P1 前）、`getShares`/`createShare`（P1）、`hls.m3u8`、`getAvatar`、`getCaptions`、`getPlayQueue`/`savePlayQueue`（P1 随 indexBasedQueue 通告一并实现）

## 6. ID 与参数映射备忘

- ID 一律十进制字符串；coverArt ID 带 `al-/tr-/ar-/pl-` 前缀
- `musicFolderId` 参数：接受但 MVP 单库忽略（getArtists 等不按 folder 过滤，P1 多库隔离再启用）
- `stream` 的 `format`：`raw`→直传；`mp3/opus/ogg/aac`→ffmpeg `-f mp3/-f opus(...)/-f ogg/-f adts`；`maxBitRate=0`→不限
- `contentTy` pe 映射与 `suffix`/`transcodedSuffix` 按 codec 表（shared 常量）
- `getAlbumList2 type=byYear`：`fromYear/toYear` 参数
- 分页默认 `size=10, offset=0`，上限 500

## 7. 验收标准（Feishin 手工回归清单）

1. 添加服务器（token 模式）→ 登录成功，版本信息正确显示
2. 专辑/艺人/流派/收藏 四个 tab 数据正常、封面显示
3. 搜索（歌曲/专辑/艺人）可用，中日文关键词命中
4. 播放：直传（flac 网页端不支持时 Feishin 桌面端可直解）与转码（maxBitRate=128, format=opus）都出声、进度条正确、seek 正常（直传）
5. star/unstar、评分 → 网页端/第一方 API 数据一致
6. 播放列表增删改、歌曲增删排序
7. scrobble：听完后 getStarred/getAlbumList2(frequent) 与服务端 plays 表一致
8. 触发扫描/查看扫描状态
9. legacy 明文密码模式登录可用
10. 错误路径：错密码 → 客户端提示认证失败而非崩溃
