# OpenMusic 设计文档 —— 架构

## 1. 技术栈

| 层 | 选型 | 说明 |
|----|------|------|
| 运行时 | **Bun** | dev/运行/测试统一用 bun，不用 node/npm/pnpm |
| 后端语言 | **TypeScript + Effect 4（rc 线）** | 见下方「Effect 版本决策」；全部业务代码以 Effect 风格编写 |
| HTTP | `effect/unstable/http(api)` + `@effect/platform-bun` | 第一方 API 用 **HttpApi DSL**；Subsonic 层用低层 `HttpRouter`；挂载到 `Bun.serve` |
| 数据库 | **PostgreSQL 17**（podman 容器） | `@effect/sql-pg`，**手写 SQL** + Effect Schema 解码，PgMigrator 管迁移 |
| 元数据 | `music-metadata`（标签） + `ffmpeg`（封面提取、转码） | 见 5. 扫描器 |
| 前端 | **React 19 + Vite + TanStack Router/Query + TailwindCSS（shadcn/ui 风格）** | SPA，dev 时 Vite proxy 到后端，prod 由后端 serve 静态文件 |
| 共享代码 | `packages/shared` | Effect Schema 定义（Track/Album/Artist/...），前后端共用 |
| 部署 | podman compose（db + app） | app 镜像基于 `oven/bun`，内嵌前端构建产物 |

### Effect 版本决策（2026-09-15 迁移至 v4 rc）

**2026-09-14 初版**：锁 Effect 3 稳定线（当时 `@effect/platform`/`@effect/sql` 无 v4 版本，混装报 `Cannot find module 'effect/FiberRef'`）。

**2026-09-15 更新**：npm 出现 v4 rc 全家桶后整体迁移（用户决策：追最新 rc）。v4 的包结构重组——旧 `@effect/platform`/`@effect/sql` 包名**在 v4 线不存在**，HTTP 抽象并入 `effect/unstable/http(api)`，FileSystem/Path 并入 `effect` 主包，运行时只剩薄实现包：

```
effect@4.0.0-rc.115 + @effect/platform-bun@4.0.0-rc.115
+ @effect/sql-pg@4.0.0-rc.115 + @effect/platform-node-shared@4.0.0-rc.115
```

注意：`effect/unstable/http*` 是 **unstable** 目录，rc 线仍在 churn（rc.115+ 的 breaking 变更需整套同步适配）；`latest` 仍是 3.22.2。升级纪律不变：四个包一个 commit 整体切，不带业务改动。

## 2. Monorepo 结构（bun workspaces）

```
openmusic/
├── apps/
│   ├── server/            # Effect 后端
│   │   └── src/
│   │       ├── main.ts            # 入口：组装 Layer，启动
│   │       ├── config.ts          # 环境变量 → Effect Config
│   │       ├── db/
│   │       │   ├── migrations/    # NN-name.sql 迁移文件（只增不改历史）
│   │       │   ├── pg.ts          # @effect/sql-pg Layer
│   │       │   └── migrator.ts   # 启动时逐文件迁移
│   │       ├── domain/            # 域 Schema（Effect Schema）与错误定义
│   │       ├── repo/              # 数据访问层（手写 SQL：users/music-folders/browse/search/
│   │       │                      # playlists/annotations(含 plays)/subsonic/agent-sessions/
│   │       │                      # album-lifecycle/library-exclusions/metadata-overrides）
│   │       ├── service/           # 业务 Service（Context.Tag + Layer），只承载需要编排的领域
│   │       │   ├── auth.ts        # 会话/用户/首启引导/Subsonic 凭据加密
│   │       │   ├── scanner.ts    # 扫描/封面/专辑归组
│   │       │   ├── stream.ts     # 流/转码/封面回发
│   │       │   ├── lyrics.ts / lyrics-mcp.ts   # 歌词 sidecar+内嵌读取、agent 歌词工具
│   │       │   ├── youtube/      # 导入：downloader/metadata/captions/removals/mcp
│   │       │   ├── netease/     # 网易云导入：source/api/metadata/downloader/imports/mcp
│   │       │   └── agent/         # 内嵌 AI 助手：tools/agent-service/embedded/voice
│   │       ├── http/
│   │       │   ├── api/           # /api/v1 HttpApi：group + handler + schema
│   │       │   ├── subsonic/      # /rest/*view HttpRouter + XML/JSON 序列化
│   │       │   ├── media.ts / static.ts / agent-events.ts / agent-voice.ts   # 低层路由
│   │       │   └── middleware/    # 会话认证等
│   │       └── util/
│   ├── web/               # React SPA（src：api/ routes/ player/ components/ + android-assistant/）
│   ├── tui/               # 终端客户端（@opentui/react + 原生 audio）
│   └── android/           # 安卓客户端（Kotlin + Compose + Media3）
├── packages/
│   └── shared/            # 前后端共享的 Effect Schema 与常量
├── docs/                  # 本设计文档
├── compose.yaml           # postgres（+ 可选 app）
├── Containerfile          # app 镜像（两阶段：web build + 运行时）
├── vendor/opencode/       # vendored OpenCode SDK tgz（AI 助手线，docs/08）
└── AGENTS.md
```

## 3. Effect 架构

### 3.1 分层原则

- **Service = `Context.Tag` + `Layer`**，接口只暴露返回 `Effect` 的方法
- **依赖单向**：`http → service → repo → db`；禁止跨层直调
- **所有对外数据结构用 Effect Schema 定义**（请求解析、DB 行解码、响应序列化同源）
- **错误是带 tag 的 `Data.Error`**，在 HTTP 边界统一映射（见 3.4）
- **副作用资源**（ffmpeg 进程、扫描任务、缓存目录）由 Layer 管理，`acquireRelease` 保证清理

### 3.2 Layer 组装（main.ts）

```ts
// main.ts —— 伪代码，示意 Layer 组装方向
const Server = BunHttpServer.layer({ port, hostname })  // @effect/platform-bun
const Pg     = PgClient.layer({ url })                  // @effect/sql-pg
const MigratorLayer = Migrator.layer({ migrations })

const App = HttpApi.toWebHandler(ApiApi).pipe(/* ... */) // /api/v1
const Rest = HttpRouter.empty.pipe(/* subsonic 路由 */)  // /rest/*

Layer.provideMerge(ServicesLayer, Pg) // repo → service 依赖注入
// ... 最终 Bun.serve({ fetch: app }) 由 platform-bun 接管
```

路由挂载：
- `GET|POST /api/v1/*` → HttpApi（`/api/docs` 自动生成 OpenAPI 页面）
- `GET|POST /rest/*` → Subsonic HttpRouter
- `GET /*` → 静态文件（apps/web 构建产物；dev 下不挂载，走 Vite proxy）

### 3.3 关键 Service 职责

Service 层只承载**需要编排的领域**；简单 CRUD 由 `/api/v1` handler 直调 repo（无 service 中转）。搜索、收藏/评分、播放列表、播放上报（原设计稿里的 Search/Annotation/Playlist/Scrobble Service）实际落在 repo 层（`search` / `annotations`（含 `PlayRepo`）/ `playlists`），由 handler 直调。

| Service | 职责 | 关键点 |
|---------|------|--------|
| `auth.ts` | 登录/登出、会话（HttpOnly Cookie + DB sessions 表）、首启引导、Subsonic 凭据加密 | `Bun.password`（argon2）；会话滑动过期 30 天 |
| `scanner.ts` | 手动触发扫描；单飞（同一时刻仅一个任务）；状态机与进度 | 见 5 |
| `stream.ts` | 直传 / 转码 / 封面字节流；Range 请求；转码缓存 LRU | 见 6 |
| `lyrics.ts` / `lyrics-mcp.ts` | 歌词 sidecar 与内嵌标签读取、绑定/编辑；agent 歌词工具 | docs/04 歌词组 |
| `youtube/` | yt-dlp 下载、标签写入、字幕导入、物理删除票据 | docs/04 导入组 |
| `netease/` | 网易云导入：URL 白名单解析、明文 API 客户端、yt-dlp 驱动、时长校验、歌词入库 | docs/04 网易云导入组 |
| `agent/` | 内嵌 AI 助手宿主、music 工具面、SSE/听写 | docs/08 |

### 3.4 错误模型

- 域错误示例：`UserNotFound`、`InvalidCredentials`、`ScanInProgress`、`TrackNotFound`、`UnsupportedFormat`
- 第一方 API：HttpApi handler 用 `Effect.catchTag` 精确映射为 HTTP 状态 + `{ code, message }`
- Subsonic 层：统一映射到 `subsonic-response.status="failed"` + 标准错误码（0/10/40/70 等）
- 意外异常：`Cause.pretty` 记日志，对外 500 通用错误，不泄漏内部细节

### 3.5 日志与观测

- `Effect.log` + `Logger.json`（prod）/ `Logger.pretty`（dev），`LOG_LEVEL` 控制
- HTTP 访问日志：method/path/status/duration/userId（stream 类端点降采样记录）
- 不引入 OpenTelemetry（P2 视需要）

## 4. 认证与会话

### 4.1 第一方 API（浏览器）

- `POST /api/v1/auth/login`（username+password）→ 生成 `sessions` 行，Set-Cookie：`om_session=<token>; HttpOnly; SameSite=Lax; Path=/`（prod 增加 `Secure`）
- 中间件读 cookie 查 sessions 表（带过期清理），注入 `CurrentUser` 到请求上下文
- `POST /api/v1/auth/logout` 删除会话行

### 4.2 Subsonic 层（Feishin）

每请求认证（参数在 query 或 form body 中）：
- `u` + `t`（md5(password+salt)）+ `s`：token 模式（Feishin 默认）
- `u` + `p=enc:<hex>`：hex 模式
- `u` + `p=<plain>`：明文模式（Feishin legacy 选项）

实现：按 username 取用户 → `Bun.password.verify`（注意 token 模式需存一份 md5(password+salt) 可验证的形式，见 `05-subsonic-compat.md` §3 的具体方案）。

## 5. 扫描器

```
触发：POST /api/v1/library/scan（管理员） 或 /rest/startScan.view
      └─ ScannerService.scan()（Fiber 内运行，立即返回）
      └─ ?force=true 跳过 mtime/size 增量基线，全量重解析（归组规则升级后
         修存量；消失清理语义不变）

流程：
1. 遍历所有 music_folder，收集音频文件（扩展名白名单：
   flac mp3 m4a ogg oga opus wav wv ape aiff dsf）与伴生 `.cue` 文件
   —— Effect 原生循环，进行中持续上报「已发现 N 个文件」（phase=walking）
   —— 读失败（根不可达=挂载断开/目录被删、子目录 readdir 失败、单文件 stat
      失败）只记错误并跳过该子树/文件，不中止 walk：**「看不见」≠「已消失」**，
      远程 FS（NFS/SMB/sshfs）扫描数小时里一次瞬时读错误很平常
2. CUE 配对 → 虚拟分轨计划（docs/03 §2.9）：cue FILE 按「同目录 + 文件名
   （大小写不敏感）」匹配 walk 收集的音频文件；**同一镜像被 ≥2 轨引用才虚拟化**
   （每 FILE 恰一轨 = 分轨自带 cue → 物理索引，防同内容双份）；引用的镜像不在库
   （分轨 rip 保留 cue 的典型形态）→ 整节跳过；分段边界不可信（INDEX 缺失/乱序）
   → 该镜像走物理。cue 文本编码 UTF-8 → shift-jis → gb18030 → big5 → euc-kr
   回退链（日系抓轨几乎全是 Shift-JIS；详见 util/cue.ts 的伪影惩罚启发式）
3. 增量 diff：与 tracks 表按 (music_folder_id, path) 对齐
   - 新增/变化（mtime 或 size 不同）→ 入待处理队列（walk 不完整的目录也照常索引可读部分）
   - 消失 → 分块删除（500/块；单语句 65535 参数上限，大库批量挪走不受影响）
     **只在 walk 零错误的目录上执行**：瞬时读错误下清库不可逆
     （play 墓碑化、收藏/评分清扫），恢复后的下一次完整扫描自然补做清理
   - 磁盘键 = 物理存活路径（不含被虚拟化的镜像——cue 出现前的旧物理行由此
     清除）+ 当前虚拟合成键（cue 改轨数后不再生成的旧合成键由此清除）；
     虚拟镜像跳过 mtime diff，每扫重建（幂等，代价 = 专辑数量级）
3. 元数据提取（music-metadata，并发 8）
   → 流水分批：解析一批（500）→ 立即入库一批 → 丢弃（内存有界）
   → 快速解析抛错（例如带大封面的跨页标签）或缺时长时，先完整解析一次，不区分扩展名。
     若两个模式都失败才用 ffprobe；标签逐字段按容器 → 主音轨 → 主视频轨补缺。
     附图按 attached_pic 识别/提取，不把视频首帧当封面。
   → 手动提供的文字元数据按物理 track_id 持久化（0011）。定点入库、增量和强制扫描
     均优先用显式字段；albumartist 分组推断不能盖掉显式覆盖值。未指定的字段仍随文件变化。
   → 结构不可读守卫：连采样率/声道都拿不到（moov 缺失的 m4a 下载残骸、
     FourCC 损坏的 FLAC；ffprobe 偶尔 exit=0 但全零的假成功同罪）→ 弃单记错，
     不入库为死曲；0 字节文件在 walk 即跳过
   → 流式编码 FLAC（STREAMINFO 长度未知）时长=0 为已知限制：可播、进度正常，
     仅 seek 条禁用；全量解码回填留作 P2
   → upsert 用 unnest 多行语句（artists/albums/tracks 各一条，批内按冲突键
     与路径双重去重；可空列/大数列以 PgTypes.array 显式定型——逐元素推断 OID
     对全 null 数组与 int4/int8 混装会直接抛错）
   → album/artist 快照身份见 docs/03 §2.8；虚拟行 = 镜像解析一次 + cue
     分段展开 N 行（docs/03 §2.9）
   → 碟号链：标签 DISCNUMBER → 父目录名末段是纯碟号（`Disc 1`/`CD-2`/`cd3`，
     util/album-grouping.ts 的 DISC_DIR_RE，只认整段——Discography 不误伤）
     → 1。目录分碟（`ReStart-F/Disc 1|2/`）是标签缺失时唯一可靠的真相源
   → 专辑名回填（applyAlbumFallbacks，跨文件，裁决前）：album 标签缺失不再
     直落 Unknown Album——按专辑目录分组两级回填：① 标签传染：组内带真实
     album 标签且唯一 → 传染给无标签行（半标注专辑）；② 目录名兜底：组内
     无标签证据但多数文件名带轨号前缀（`(01) x`/`01. x`，专辑 rip 的最强
     命名信号）→ 目录末段即专辑名（实测 Vocaloid Discography 合集 198 个
     目录、~2000 首全中此形态）。门控 ≥2 文件且带轨号 ≥半数：散曲目录
     （mv/piano 下载件、单曲多版本收藏——无轨号平铺）不触发，保持 Unknown。
     目录名里的来源后缀（`(FLAC)`/`(MP3)`）不剥——剥了会把同专辑双格式
     rip 并成一张曲目翻倍的专辑。证据集同下 = 本次扫描实际解析的文件，
     增量视野不全时暂不回填，force 全量收敛
   → albumartist 统一裁决（跨文件，整个 folder 解析完后一次性进行）：按
     「专辑目录（尾部碟号段剥掉）+ 专辑名」分组——组内显式 albumartist 唯一
     → 该艺人（半标注专辑自动并入已标注侧）；显式对立且众数 ≥80% → 众数
     吸收少数派（个别文件串标签）；显式对立且分散（ripper 给 VA 合辑逐曲
     填表演者的「谎话标签」）→ Various Artists；无显式时曲作者唯一 → 该
     艺人，多名 → Various Artists。显式一致时 (artist, name) 全局键照旧；
     推断只在目录范围内做，不同目录的同名专辑不会被错误合并。注意证据集
     = 本次扫描实际解析的文件：增量扫描向老目录增补单曲时视野不全可能暂时
     归错，下次全量/force 扫描自然收敛
   → 空白标签（artist=""/album="" 等空串）视同缺失：走 Unknown 兜底身份，
     否则会落一个名字为空的艺人行
4. 封面解析优先级：内嵌图片（ffmpeg 提取落盘到 DATA_DIR/covers/，受
   COVERS_CACHE_MAX_BYTES LRU 守护，与转码缓存共用淘汰器）
   > folder.jpg/png、cover.*、<album>.*（采样/目录统计先剥虚拟行 path 的
     "#NNN" 合成后缀；专辑目录 = 剥掉尾部碟号段后的目录——多碟专辑把
     Cover.jpg 放专辑根是主流摆放，`Album/Disc 1` 不算跨目录）
     固定/专辑名候选全 miss 时目录图片挑选兜底（pickCoverImage）：单图
     直接用；多图按语义优先——含封面词（cover/front/folder/album，与固定
     候选同序）> 纯数字 stem 取最小（booklet `00` 起封面惯例）> 排除非封面
     词（back/rear/inside/inlay/disc/cd/dvd/obi/spine/vinyl——底面/内页/
     盘面/腰封照）后字典序第一；全是非封面词 → 放弃（宁缺毋滥）。覆盖
     自扫合集「封面+底面+宣传图整套同存」与封面命名和专辑名不同步的形态
5. 汇总物化：album 的 duration/track_count、artist 的 album_count
   （虚拟行天然参与：分段时长相加 = 专辑时长、行数 = 曲目数）
   孤儿清扫：artist 的存亡同时看 tracks.artist_id 与 albums.artist_id
   （只看前者会把「从未以曲作者出现的专辑艺人」——VA 合辑——连同专辑
   曲目整棵 FK 级联删除，且每次重扫重复发生）
   空专辑：library_albums 只展示仍有 tracks 行的专辑。最后一首离开后，有播放历史、
   收藏或评分的 albums 行保留原 ID，不能凭名字改挂；无这些引用才清理。单曲移除、
   改标签定点入库、注销目录均在 DB 事务内只复核相关专辑，无需遍历音乐文件。
6. 全程写扫描状态（内存 + 状态端点可查询；errors 封顶 100 条防响应膨胀）

取消：DELETE /api/v1/library/scan（管理员，幂等）——interrupt 扫描 Fiber，
落在下一个语句/解析间隙；已提交批次保留，重扫增量续上。
```

- **不做**：定时扫描、inotify、bit-perfect 校验、去重猜测（同名多版本文件按普通文件入库）
- ID3v2 各种字段缺失时的回退链（artist → "Unknown Artist" 等）在 `packages/shared` 中统一定义

## 6. 流播放与转码

Android 离线单曲循环（0.1.10）：固定文件的 200 和 206 响应须在**实际 HTTP 连接**上分别携带整文件长度和分段长度。第一方媒体路由保留原生 BunFile 响应；把文件转成通用 ReadableStream 后，即使进程内测试看到长度，在线路上也可能变成 chunked。实时 ffmpeg 输出不伪造长度。Media3 的 ProgressiveMediaPeriod 默认标记「若长度未知则不缓存」，App 只对 OpenMusic 有限曲目流移除该标记，使分段照常写入 SimpleCache。断网不切换 MP3 源。完整缓存可离线循环；未写入的字节仍需联网补齐。

### 6.1 端点行为

- `GET /api/v1/tracks/:id/stream?format=&maxBitRate=`
  - `format=raw` 或参数缺省且原格式浏览器可播 → **直传文件**，支持 Range（Bun.file 天然支持）
  - 否则 → 转码
  - **CUE 虚拟曲**（is_virtual，docs/03 §2.9）恒经 ffmpeg：实际起点 =
    `offset_ms/1000 + timeOffset`（输入端 -ss，O(1)），输出侧 `-t` 卡分段终点
    （流在边界自然 EOF，客户端 seek/ended/进度语义与普通曲完全一致）；
    物理镜像不存在于磁盘上的合成路径——流/下载一律落到剥后缀的真实文件
- Subsonic `/rest/stream.view`、`/rest/download.view` 复用 `StreamService`

### 6.2 转码

```
cacheKey = sha256(trackId + format + maxBitRate + 音频指纹参数)
1. 命中缓存（完整文件）→ 直接回发
2. 未命中 → Bun.spawn ffmpeg:
   ffmpeg -i <file> -map 0:a:0 -vn -b:a <bitrate> -f <fmt> -
   stdout 以 Stream 回发给客户端（首字节延迟低）
   同时 tee 到临时文件，完成后原子 rename 进缓存
3. LRU 淘汰：后台 Fiber 定时扫描缓存目录 atime，超过
   TRANSCODE_CACHE_MAX_BYTES 时从最旧开始删除
   **单条目体积上限（256MiB）**：估算体积 = 时长 × 码率/8 超限的条目
   （如 14h 录音完整转码 ≈ 2GiB）纯流式透传不落盘——防单文件冲刷整个预算
4. 并发上限：Effect.Semaphore(TRANSCODE_MAX_CONCURRENCY)，
   超出排队等待
```

支持的 `format`：`raw`（原样）、`mp3`、`opus`、`ogg`（vorbis）、`aac`、`flac`（直传重封装）。

### 6.3 转码配置

- 全局默认 profile（env/管理 API）：`format=opus, maxBitRate=128`
- 每用户覆盖（users 表字段，P1 管理界面）
- 客户端显式参数永远优先于 profile

### 6.4 Web 播放端缓存

- 位置：浏览器 IndexedDB（库 `openmusic` / store `audio-cache`）。
  Cache Storage 与 Service Worker 都要求 secure context，tailnet 的
  `http://` 访问下不可用；IndexedDB 没有这个限制
- 键 = 流请求 URL：raw 直传与 `?format=mp3&maxBitRate=320` 转码回退
  各存一份（换服务器地址不串缓存）
- 命中 → `blob:` URL 直接喂 `<audio>`，重复播放零网络；未命中 → 网络流
  起播，起播稳定（8s 且进度 >3s）后后台整首拉取落库——`<audio>` 不能
  边播边写，首次播放会有一次额外下载
- 条目带 `version = createdAt:sizeBytes`，文件变化后旧条目自动作废；
  不设硬上限（同 Android），配额写满时按 `usedAt` 淘汰最旧一半
- 队列抽屉底部显示条数/体积，可手动清空

## 7. 配置（环境变量）

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP 监听 |
| `DATABASE_URL` | 必填，无内置密码 | Postgres 连接（compose 映射到宿主 5433，避免与常见占用冲突） |
| `DATA_DIR` | `./data` | 封面、运行时数据（git 忽略） |
| `TRANSCODE_CACHE_DIR` | `/tmp/openmusic/transcode` | 转码缓存 |
| `TRANSCODE_CACHE_MAX_BYTES` | `5368709120`（5GiB） | 缓存上限 |
| `COVERS_CACHE_MAX_BYTES` | `536870912`（512MiB） | 封面缓存上限（与转码缓存共用淘汰器，docs/02 §6.2） |
| `TRANSCODE_MAX_CONCURRENCY` | `4` | 并发转码上限 |
| `LOG_LEVEL` | `info` | |
| `SERVER_IDLE_TIMEOUT` | `0`（禁用） | Bun.serve 空闲连接超时秒数；默认禁用——流式播放依赖长连接（docs/07 §7 冻住坑） |
| `OPENMUSIC_TAG_PYTHON` | `python3` | YouTube/网易云导入写标签的解释器（需可 import mutagen；容器内已指向 yt-dlp venv，裸机开发需自备） |
| `NETEASE_REAL_IP` | 空 | 可选：网易云导入对外的伪装出口 IPv4（明文 API `X-Real-IP` 头 / yt-dlp `--xff`） |
| `OPENMUSIC_ADMIN_USER` / `OPENMUSIC_ADMIN_PASSWORD` | — | 首次启动且无用户时创建管理员；密码缺省则生成随机密码并打印一次 |
| `MUSIC_FOLDERS` | — | 首启种子（逗号分隔绝对路径）；music_folder 表为主，此后以 API 管理为准 |
| `OPENMUSIC_SECRET` | — | Subsonic 凭据加密密钥（≥16 字符）；缺省首启生成 `DATA_DIR/secret.key`（后果见 docs/07 §3） |
| `AGENT_ENABLED` / `AGENT_CONFIG` | `false` / `<DATA_DIR>/agent-config.json` | AI 助手开关与独立配置文件（docs/08） |

## 8. 本地开发与部署

### 8.1 Dev

```bash
podman compose up -d db        # postgres:17-alpine，compose 映射宿主 127.0.0.1:5433 → 容器 5432
bun install
bun run --filter @openmusic/server dev   # :3000，watch 模式
bun run --filter @openmusic/web dev      # :5175，proxy /api /rest → :3000
```

### 8.2 Prod（podman compose）

- 镜像：`oven/bun:1` 基底 → `bun install --production` → 拷贝源码 + web 构建产物 → `bun apps/server/src/main.ts`
- app 容器依赖 db 健康检查（`pg_isready`），启动时自动跑迁移
- 挂载：音乐目录（只读）、DATA_DIR、TRANSCODE_CACHE_DIR
- 反向代理/HTTPS：交给外部（Caddy/nginx/路由器），应用自身不管 TLS

## 9. 测试策略

- **单元**（bun test）：Schema 解析、扫描 diff 逻辑、Subsonic 参数/序列化、转码参数映射
- **集成**：compose 起 test db，对 HttpApi 用 `HttpApiClient`（in-process）跑核心链路：登录→扫描（fixture 音乐文件）→浏览→stream→收藏
- **Subsonic 兼容**：把 Feishin 实际发送的请求形状固化为快照测试；每里程碑用真实 Feishin 手工回归
