# OpenMusic 设计文档 —— AI Agent 集成（A 线）

> 状态：设计稿（2026-09-19，待用户确认后实施）
> 关联：docs/01 §6.3（AI 搜索扩展点）、docs/03 §2.8（plays 事实日志 = AI 数据基底）、docs/06 P2（语义搜索）。
> 上游事实源：OpenCode V2 文档（opencode.ai/v2/docs/build/sdk 等）+ vendored 源码包说明（`vendor/opencode/README.md`）。

## 1. 定位：什么叫「AI-native 的 OpenMusic」

不是「加个聊天窗口」，而是三条结构性的事：

1. **域层长出工具面（tool surface）**：曲库浏览/搜索/队列/播放列表/收听史这些既有 service 能力，以带 JSON Schema 输入、带描述的工具形式二次暴露——任何 agent 运行时（OpenCode、未来别的）都能直接消费。工具面是第一公民，与 REST API 平级。
2. **Agent 运行时可插拔**：OpenMusic 自己不实现 agent 循环（工具调用、流式、上下文压缩、provider 抽象、权限），内嵌 OpenCode 宿主获得全部能力；`AgentService` 是一个 Port，未来换实现不动域层。
3. **数据基底变现**：docs/03 §2.8 设计的 plays 不可变事实日志，从第一天起就是 agent 的取数面（收听画像注入、推荐理由可解释）。P2 的 pgvector 语义搜索落地后作为工具接入，而非独立功能。

**非目标**：不给 agent 开放文件系统写能力；不让 agent 直接跑 SQL；TUI 端暂不接入。Android 助手见 `apps/android/.../agent/AssistantSurface.kt` 和 `AssistantBridge.kt`。

## 2. 集成姿态选型

| 姿态 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A. 内嵌 SDK | `@opencode/sdk` 宿主跑在 server 进程内，无 HTTP listener | 自包含、随服务部署、会话隔离（默认 `:memory:` DB） | 进程重、effect 版本耦合 | **主选** |
| B. 外挂客户端 | server 连用户正在跑的 OpenCode 后台服务（`@opencode/client`） | 复用用户已登录的 provider/凭据/插件，会话可在用户 TUI 里续聊 | 依赖桌面侧服务存活；podman 部署形态没有它 | 备选/增强，不承载核心 |
| C. 直连 LLM | 自己写工具调用循环 | 最轻 | 重造轮子（流式/压缩/重试/权限） | 否决 |

选 A 的决定性细节（源码核实，`packages/sdk/src/internal/host.ts` + `server/src/options.ts`）：

- 内嵌宿主 = 完整 OpenCode server 路由跑在 `ManagedRuntime` 里，经进程内 `fetch` transport 暴露，不开端口；
- 会话库默认 `database: { path: ":memory:" }`，与用户正在运行的 OpenCode 服务完全隔离（可改配 sqlite 文件持久化）；
- `ServerOptions.config: { content | directory | file | project }` 可内联 JSON 配置或指向 `~/.config/opencode`——单用户自托管场景**直接复用用户现有 provider 凭据**，零新增配置 UX；
- 插件 API（`@opencode/plugin`）提供 `ctx.tool.transform`（注册工具）、`ctx.agent.transform`（定制 agent）、`ctx.session.hook("context")`（按请求注入曲库上下文）、`ctx.generate.text`（无会话一次性生成）。

### 2.1 关键风险：effect 版本耦合（必须先决策）

- OpenMusic 钉 `effect@4.0.0-rc.115`（四包整体切，docs/02 §Effect 版本决策）；
- npm `@opencode/sdk@2.0.8` 钉 `effect@4.0.0-rc.112`（精确版本，非区间）；
- rc 线内部有破坏性变更（本仓库 AGENTS 已记录多起），**跨副本提供 Layer/传 Effect 值 = 类型与运行时双雷**。

**决策：Promise 边界隔离。** 只用 `@opencode/sdk` 的 Promise 入口（`await OpenCode.create()`），边界上只有 Promise/普通对象进出，OpenMusic 侧用 `Effect.acquireRelease(Effect.promise(...))` 包生命周期。SDK 的 Effect 入口（`@opencode/sdk/effect`）等 OpenCode 追平 rc 线后再切。

**实施补记（2026-09-19，A1 实况）**：bun 的 `.bun` 分组把 SDK 的 effect@rc.112 与 `@effect/platform-node-shared@rc.115` 编进同组，而 `effect/ByteSize` 是 rc.112→rc.115 之间新增的子路径——启动即炸。解法：**根 `resolutions` 把 effect 统一到 rc.115**（`rm -rf node_modules/.bun && bun install` 全量重解析），运行时单副本；SDK（按 rc.112 编译）跑在 rc.115 上由 A1 集成测试全链验证。Promise 边界仍保留为类型层纪律（两版本的类型依旧不互通）。另两个 Bun 实况：**工具的调用面由 `options.codemode` 二分**（`false` = 直接 `tool_calls`，其余 = Code Mode 沙盒目录——见下方决策）；自定义 agent 走 config `agents` 字段（AgentEditor 只有 update/remove，没有 add）。

**工具面决策（2026-09-19，用户拍板）：全部 music 工具走 Code Mode**（不设 `codemode: false`）——模型在 `execute` 沙盒里以 `tools.music_search(...)` 编排调用，可组合、可 `Promise.all` 并发。连锁适配：
- Code Mode 下内层调用**没有**独立的 `session.tool.success` 事件（只有外层 execute 一组事件 + `session.tool.progress` 携带内层 `metadata.toolCalls` 的累积状态 `{tool,status,input}[]`）；
- `client-action` 由服务端自产：`music_play_now`/`music_enqueue` 成功即使用执行工具时核验的属主推送 `{type:"client-action", sessionID, kind, tracks}`，是确认卡片的唯一来源；
- SSE 是**同一属主内的多播**（`event-bridge.ts`）。每轮执行开始按 PG 登记解析属主；未登记或查询失败不投递；结束即释放映射。只投影客户端所需事件和字段，不向浏览器广播全局宿主事件。SSE 写出每批数据前只读检查原登录凭据，已撤销/过期则结束，不因接收事件自动续期。

## 3. 架构

**现行版本（2026-11-10）**：同一宿主处理会话和听写，SDK/plugin 及配套包来自 `vendor/opencode/` 固定的 fork（`2.2.5-openmusic.1`）。OpenMusic 的 Effect rc.115 与 SDK 的 4.1.0 保持 Promise 边界，不再全局覆盖 Effect。切换前对会话/凭据 SQLite 做一致性备份，不要在已迁移的 DB 上直接降级 SDK。

```
apps/server/src/
  service/agent/
    agent-service.ts   # AgentService：Context.Tag + Port 接口（createSession/prompt/wait/interrupt/subscribe）
    tools.ts           # music 工具注册表：名字 → { description, inputSchema(JSON Schema), run: Effect }
    embedded.ts        # AgentService 的内嵌实现 Layer：OpenCode SDK Promise 边界 + 插件注册
    event-bridge.ts    # 宿主事件投影 → 属主隔离的订阅（SSE 源）
  http/api/agent.ts    # /api/v1/agent（HttpApi group）
apps/web/src/
  agent/              # 聊天面板（TanStack Query + SSE 流式渲染）
```

依赖方向不破坏：`http/api/agent → service/agent → (repo/service 既有层)`。工具执行器在 main.ts 组装期捕获 OpenMusic 自己的 Runtime（`Layer.toRuntime` 产物），插件回调里 `runtime.runPromise(...)` 调域层——**同进程、无 HTTP 回环**。

### 3.1 AgentService Port（骨架）

```ts
export class AgentService extends Context.Service<AgentService, {
  createSession(input?: { title?: string }): Effect.Effect<AgentSession, AgentError>
  prompt(input: { sessionID: string; text: string }): Effect.Effect<void, AgentError>
  messages(input: { sessionID: string }): Effect.Effect<ReadonlyArray<AgentMessage>, AgentError>
  interrupt(input: { sessionID: string }): Effect.Effect<void, AgentError>
  events(input: { userId: number }): Stream.Stream<AgentEvent>   // 仅该用户的 SSE
}>()("openmusic/AgentService") {}
```

### 3.2 工具面（music 命名空间，首期清单）

只读：`music_search`（复用 SearchRepo 三路召回）、`music_album_tracks`、`music_artist_top`、`music_recent_plays`、`music_most_played`、`music_favorites`、`music_random`。

`music_recent_plays({limit:20, offset:0, distinct:"track"})`：按物理曲目去重后分页；省略 `distinct` 保留逐次播放。返回 `{plays, nextOffset}`，继续时沿用同一 `distinct` 并传 `offset: nextOffset`，`null` 表示末页。默认每页 20 条，最多 100 条。
动作（写白名单）：`music_play_now` / `music_enqueue`（TrackSummary[] + 位置）、`music_playlist_create` / `music_playlist_add`、`music_star`。
约束：入参出参全走既有 repo/domain Schema；**id 定位类查询不换 canonical 源**（沿用「收藏的是歌不是文件」的口径）；返回给模型的是精简投影（title/artist/album/id/duration），防上下文爆炸。

### 3.3 安全边界（自托管也要设防）

- 会话 Location 指向**专用 scratch 目录**（`data/agent-workspace/`，空目录），绝不指向仓库检出或 `/data` 音乐目录；
- 定制 `music` agent：permissions 默认 `edit/bash/write → deny`，只留 music 工具 + 只读工具；写类工具（play/playlist/star）在工具层再做用户态校验（CurrentUser 语义传递）；
- provider 配置：仍与 `~/.config/opencode` 隔离；为管理页热更新，使用 `config.file` 指向 `AGENT_CONFIG` 或 `DATA_DIR/agent-config.json`，并关闭项目配置发现。既有 `{env:VAR}` 引用保留；从网页新增的凭据由 SDK 存储，不写入配置文件。
- 会话持久化：`database.path` 指向 **OpenMusic data 目录下的专用 SQLite 文件**（`data/agent-sessions.db`，2026-09-19 用户决策）。与宿主机正在运行的 OpenCode 后台服务**完全不共库**——内嵌宿主只打开显式传入的 `database.path`，配置内联、models.dev 目录是包内打包快照、KV/事件/会话全部落在这个 DB 里；宿主机服务的数据（`~/.local/share/opencode/`）对内嵌宿主不可见，反之亦然。不同路径各自持锁（`Database` 按路径 share lock），无迁移/锁冲突面

## 4. 第一方 API（/api/v1/agent）

| 端点 | 语义 |
|---|---|
| `POST /agent/sessions` | 建会话（返回 id） |
| `GET /agent/sessions/:id/messages` | 消息列表（含工具调用渲染所需结构） |
| `POST /agent/sessions/:id/prompt` | 发消息（202 + 流异步） |
| `POST /agent/sessions/:id/interrupt` | 打断 |
| `POST /agent/transcribe` | 登录后发送录音二进制（audio/webm、audio/mp4 或 audio/ogg，最大 2 MiB），返回 `{text}`；不创建消息、不自动执行操作 |
| `GET /agent/events`（SSE） | 会话事件流（低层 HttpRouter 挂载，subsonic 同款姿势；HttpApi DSL 不表 SSE） |

鉴权沿用 `om_session`（SessionAuth 中间件）。多用户隔离：sessions 表带 `owner_user_id`（agent 会话也是资源，与 playlists 同款归属语义）。

### YouTube 导入

曲库歌词是独立的内部 `lyrics` MCP，并不要求曲目来自 YouTube。`tools.lyrics.read({trackId,offset?})` 查看来源、绑定和逐行时间戳（每页最多 80 行）；`edit({trackId,text})` 保存新文本、只修改这个版本；`bind({trackId,mode,lyricsId?,filename?})` 用 `saved/file/none/auto` 指定文档、同目录 `.lrc`、解绑或恢复自动。ID 为字符串。会话属主、管理员/导入者写权限与 HTTP 相同。不会自动将字幕或搜索结果写成歌词。

**人工字幕（只读）**：`youtube.list_captions({url})` 或 `{trackId}` 二选一。只列 YouTube 提供的人工字幕轨道，排除 ASR、自动翻译与聊天回放；`tracks: []` 表示没有可用的人工字幕，不改用语音转写。`youtube.read_captions({url,language:"ja"})` 返回 `{videoId,language,kind:"manual",cues:[{startMs,endMs,text}],total,nextOffset}`。有下一页时传 `offset: nextOffset`；每页至多 80 段、12,000 字符。不会下载媒体、写歌词文件或修改曲库。REST 为需要登录的 `POST /api/v1/imports/youtube/captions/list` 和 `/read`，REST `trackId` 为字符串。网络失败与没有字幕分别报告。

**通用网页搜索**：内嵌 SDK 自带的 `websearch` 是直接工具，不是 `youtube.search`，也不是 Code Mode 的工具目录查询。部署时在独立的 `agent-config.json` 顶层设置 `"websearch": {"provider":"exa"}`，并在 `agents.music.permissions` 中将 `websearch` 的最终匹配规则设为 `allow`，保持 `webfetch` 为 `deny`。保留其他权限和已有聊天模型配置。助手可据公开检索结果引用来源；结果不是视频字幕。可用 `OPENMUSIC_TEST_LIVE_WEBSEARCH=1` 在隔离集成库运行真实搜索测试（发送固定的公开 MusicBrainz 查询）。

**删除不是一种带 `force` 参数的工具。** `remove_from_library({trackId})` 保留磁盘版本并抑制重扫；`request_file_deletion({trackId})` 只返回待人工处理的网页链接（本人登录、限时一次、输入文件名），不能在对话里用「确认」代替。两者均校验物理版本和导入者/管理员权限。仅在用户明确了目标版本和移除方式后调用。

`youtube-metadata` skill 与内部 MCP 使用同一规则：默认保留 Opus/AAC 源音频，不二次编码。用户明确要求时传 `format: "mp3"` 或 `"video"`。每种模式均默认嵌入本视频缩略图（maxres → hq，失败返回警告）；上传日取 `upload_date`，以 YYYY-MM-DD 写入容器原生标签和 PG `youtube_imports.upload_date`，不作为专辑发行年份。目录匹配仅补缺失专辑、流派；优先简介中的 Apple 发行链接或受限 Linkfire 音乐链接，曲名、艺人和时长吻合且发行候选唯一才自动采用。视频版/合作署名不被目录艺人替换；搜索或缩略图不可用时保留原标签。封面只有显式传 `metadata.cover` 才换成其他图片。单视频可带经核实的标签，播放列表不接受一套共用的覆盖值。

导入后 `youtube.catalog_search` 查候选，`youtube.get_metadata` 读取曲目及格式，`youtube.edit_metadata({trackId, metadata})` 只写传入的字段。只有导入者或管理员可写；旧档须管理员且原 MP3 自带匹配的 YouTube 来源链接。先在私有临时副本上改标签，再定点入库，编辑时数据库失败则恢复备份。经验证的媒体若遇到标签编码器不支持的标签，显式文本仍可只写曲库；原字节不变，工具返回 warnings。不为标签换编码、移除版本或全库重扫。损坏/格式不符、旧档未核实或显式要求换封面失败时不使用此降级。运行时需要 Python 3 + Mutagen + Pillow，可用 `OPENMUSIC_TAG_PYTHON` 指定解释器；容器使用 yt-dlp 虚拟环境。

`youtube` 为宿主生命周期内的 Streamable HTTP MCP（回环随机端口、进程内生成的 bearer、Code Mode）。`tools.youtube.search({query})` 仅查候选；`list_folders({})` 读取已注册根目录及可写状态，`list_subdirectories({folderId,subdirectory?})` 可按需查看一层已有子目录。助手按对话选择目标（用户明确指定但不可用时在对话中澄清）；`await tools.youtube.start_import({url,folderId,subdirectory?})` 在原调用中等待下载、转码和数据库提交，再返回最终计数、失败条目和按播放顺序排列的真实 `trackIds`。原 Agent loop 消费工具结果即可回复或按用户要求请求播放；没有 instruction update、合成用户消息或后台轮询。会话取自 SDK 协议元数据，再到 PG 核验属主；不需要 Shell 或通用文件写入权限。

网页只用既有工具时间线；不维护导入卡片、不请求进度接口。目标必须是注册根或其**已存在**的相对子目录（不跟随子目录符号链接），导入期间固定可写目录句柄。只索引新下载的文件，不扫描整库。只接收 YouTube 视频或 `/playlist?list=…`；带 list 参数的 watch 链接只取单曲。每列表上限 25 首，单首最长 30 分钟、96 MiB；同目录同视频同模式不覆盖。每用户同时 1 次导入、全站 2 次；打断时取消未完成的工作，已经入库的文件保留。

### 网易云导入

`netease` 与 `youtube`/`lyrics` 同一个回环 MCP 监听（`/netease`，由 `youtube` MCP 的 Bun.serve 挂载，同一 bearer），同样是宿主生命周期内的 Streamable HTTP + Code Mode。工具六个：`tools.netease.search_netease({query})` 只搜不下载（至多 5 个 `{title,artist,album,songId,url,vip}`）；`await tools.netease.start_import_netease({url,folderId,subdirectory?})` 在原调用中等待下载、时长校验、打标签和入库，返回终态（`state`/计数/`trackIds`/按 `songId` 的 `failures` 与 `warnings`）。目标目录与来源无关，复用 `tools.youtube.list_folders` / `list_subdirectories` 选择。

曲目管理四件（与 youtube 组同语义，服务端走同一共享移除内核）：

- `tools.netease.get_metadata_netease({trackId})`：查看标签、来源 `songId`、实际音质档位与封面状态。登录会话内只读。
- `tools.netease.edit_metadata_netease({trackId, metadata})`：只改传入字段，保留 ID 与文件名、不重新下载；`cover` 支持 `"netease"`（回源恢复）、`*.music.126.net` 链接或 data:image 内联图；文本未能嵌入文件时如实返回 `warnings`。仅导入者或管理员。
- `tools.netease.remove_from_library_netease({trackId})`：仅在用户明确要求移出曲库时调用；只删曲库条目、保留磁盘文件，返回 `{removedFromLibrary:true, fileDeleted:false}`。
- `tools.netease.request_file_deletion_netease({trackId})`：仅在用户明确要求连原文件一起删除时调用；只创建 5 分钟人工确认链接，返回 `{requestId, reviewPath, expiresAt, state:"awaiting_human", fileDeleted:false}` 与 Markdown 链接。**助手没有 confirm/review 工具，也不得请求任何确认类工具**——token 与确认页只属于票据属主本人（Web `/review-deletion/:requestId`，逐字输入文件名），对话里不代确认、不声称已删除。

**权限 action 名（窄 allow-list 部署必须显式放行）**：Code Mode 工具的权限 action 是下划线全名——`netease_search_netease`、`netease_start_import_netease`、`netease_get_metadata_netease`、`netease_edit_metadata_netease`、`netease_remove_from_library_netease`、`netease_request_file_deletion_netease`（youtube/lyrics 同理，如 `youtube_start_import`）。**未匹配任何规则的 action 默认落到 `ask`，而内嵌宿主没有应答权限请求的通道**（事件桥只投影消息/工具/执行事件，无权限卡片）——落到 `ask` 的调用会挂起直到会话被 interrupt 或宿主关闭，表现为「助手卡死」而非报错。因此窄 allow-list 姿态在本部署形态下不可用：保持 `allow *` + 显式 deny（`edit/bash/write/shell/webfetch` deny、`websearch` allow）的清单，或为上面每个 action 显式写 `allow` 规则。

`netease-import` skill（`agent-home/skills/`，embedded seed）教助手：何时选网易云 vs YouTube（主流发行室版本 vs 视频/现场/自唱）、VIP/付费在预检即被明确跳过（failures 里说明「VIP/付费歌曲需要会员账号，未导入」）、25 首上限与歌手热门截断、时长校验会丢弃疑似试听片段（双保险不依赖预检）、导入自动带元数据与原文/翻译歌词、匿名 320k 上限与海外地区差异如实告知，以及管理四件的纪律（先 get 核对、edit 只传要改的字段、移出与删除都须用户明确要求、删除只给人工链接）。REST 等价端点见 docs/04 网易云导入组；MCP 打断走宿主 interrupt（与 `youtube.start_import` 同款 per-session abort）——该 abort 只覆盖进行中的导入调用，管理四件是有界/事务化的短操作，不参与打断。除助手对话外，Web 端 `/imports` 页面直接消费 REST 端点（搜索/粘贴链接、目录选择、同步等终态与结果明细；工具时间线与既有行为不变），助手欢迎 starter 另提供「导入网易云链接」示例；管理类工具（`get_metadata_netease`/`edit_metadata_netease`/`remove_from_library_netease`/`request_file_deletion_netease`）沿用与 YouTube 同名语义。

skill seed 升级：bundled 文案演进时，seed 只对「逐字节等于已知官方旧种子」的副本做迁移（当前清单：d6b8e2d 双后端中间版与 9039856 匿名 v1，见 `service/agent/skill-seed.ts` 的 `STALE_NETEASE_SEEDS`）；任何 checksum 不匹配的实例视为用户手改，原样保留（skill Watcher 热刷新，手改即生效）。

## 5. Web 前端

Android 0.1.4 起，管理员可在「设置 → 服务器管理」打开同一份 Web `AdminPage`。包括服务器音乐目录（新增、重命名、移出曲库）、增量／强制扫描与取消、用户增删、聊天／听写模型、供应商凭据、自定义兼容服务与 Console 设备授权。普通成员保留账号、服务器、扫描状态和退出入口。管理文档与会话文档使用不同本地源、WebView 和端口能力清单；聊天页不能发管理请求，服务端仍逐请求鉴权。Console 授权在系统浏览器的官方 HTTPS 页面完成。

Android APK 打包同一份 `AgentConversation`、Zustand store、时间线、Markdown 与听写组件。0.1.5 起，「音乐助手」是底栏正中的独立页面（主页 / 资料库 / 音乐助手 / 搜索 / 收藏）；可切换其他页签或使用系统返回键，不设关闭按钮或小窗。离开助手或退后台会释放录音，不中断后台工具或音乐播放，同一登录期间的会话选择和草稿保存在内存中。听写不会自动发送，需服务端配置听写模型。

Android 不加载服务器提供的网页。WebView 只读取 APK 中的 HTTPS 本地资源；仅向这个源转移 WebMessagePort。原生 OkHttp 带当前登录凭据请求允许的会话、inbox、听写接口并转发 SSE；不把 Cookie 交给 JS、不允许任意网络或本地文件访问。播放卡片经用户确认后原生按 id 取曲目，交给 Media3。外部链接在浏览器打开，不携带原生 Cookie。Android 构建前在仓库根目录 `bun install --frozen-lockfile`；Gradle 的 `buildAssistant` 自动生成 APK 资源。`apps/android/test/assistant-fixture.py` 提供本地测试会话、阻塞任务、SSE 断线与模拟转写，无需模型 Key。

Console 可下发部分模型能力字段（如 `{tools: true}`），由宿主与基础目录合并，不要求用户另填工作区 Key。管理页分别筛选工具模型和兼容音频输入的听写模型。语音输入需要 HTTPS 或 localhost；录音最长 60 秒，可取消。服务端每用户 1 个、全站最多 3 个同时请求，按管理员配置转写，不接受客户端指定供应商或凭据。

Web / Android 0.1.13 的听写走 `POST /api/v1/agent/sessions/:id/transcribe`。后端核实会话归属后才传 `contextSessionID` 和 `overrides.context_pairs: 3`，供听写模型参考最近最多 3 轮对话正文；不另发草稿、曲库、工具载荷或工作区路径。旧的 `/api/v1/agent/transcribe` 不指定会话，保持零上下文，不猜测最近会话。不启用 SDK 内容日志。临时 ffmpeg 子进程只处理音频，不运行额外常驻服务。

管理 → 音乐助手：仅管理员可读取目录、添加 OpenAI 兼容服务（含模型 ID）、为支持简单 API Key 的供应商连接账号，或使用 OpenCode Console 设备授权。Console 的 workspace provider/model 由内嵌 SDK 发现，不复用浏览器 cookie、宿主机 CLI 登录或 OpenMusic 用户密码。使用个人 Console 账号等同于授权全站助手使用该工作区额度。

模型列表只投影可用且支持工具的模型；保存更新 `agents.music.model`，SDK 热加载，不切断当轮执行，旧会话下一次 prompt 对齐所选模型。原子修改仅涉及目标 JSONC 字段，保留其余配置和注释。API Key 只写、账号可断开；环境配置的凭据不可从网页删除。管理页应通过可信网络或 HTTPS 访问，不要在不可信网络的明文 HTTP 上提交密钥。

会话标题复用 OpenCode 的 `session.renamed`，不另行请求模型。服务端写回已登记会话并仅通知属主；即使生成已结束，标题仍可更新。读取列表时，旧的空标题可从宿主已有的标题补回，不覆盖非空标题。未生成标题时网页显示「未命名会话」。

- Web 音乐助手是登录后的独立页面 `/assistant`（桌面/手机导航、正在播放页与 `Ctrl+J` 均可进入）。桌面左侧会话列表、中间时间线和输入区；手机按需打开会话列表。`/assistant?session=…` 支持刷新及浏览器前进/后退，路由不会打断底部播放器或正在运行的 Agent。
- 也可从曲库导航直接打开**小窗**，或从全屏页标题栏切到小窗并返回刚才浏览的页面。小窗不是独立浏览器窗口：可用鼠标或触屏拖动标题栏（键盘聚焦后可用方向键移动），停在播放器上方；缩放或旋转屏幕时重新约束位置。展开仍是同一会话和输入框，关闭小窗不会停止任务。每个会话的草稿只在当前登录的内存中保留，标签页存储只记小窗位置。
- 全屏与小窗使用 Web 全站的明暗主题、唱片标识与封套；`apps/web/src/agent/studio.css` 只负责助手版式。全站参考 [OpenCode 官网实现](https://github.com/anomalyco/opencode/tree/dev/services/site) 的列网格、等宽索引和蓝色交互提示。助手紧凑版按对话栏的实际宽度排版。
- 流式与历史按同一时间线渲染：`messageID + ordinal` 定位文本分段，delta 追加、snapshot 只校正本段；工具状态按 assistant 消息与 call id 原位更新。相邻工具折成一行（按曲库查询、收听记录、播放队列等分类计数），点击按调用顺序展开；Code Mode 的内层调用只计一次，不与外层 execute 重复计数。正文、用户消息和动作确认不参与折叠。
- Web 助手正文用 GFM 排版（含中日文强调、列表、表格及代码块）；只有当前接收 delta 的分段才临时补全 Markdown 并淡入新文字，snapshot、结束和历史均以原文静态渲染。用户输入仍为纯文本，不执行模型提供的 HTML 或自动加载远程图片。
- 历史从有序 `parts` 恢复正文与工具，不重放播放/入队确认；确认来自实时 `client-action`，逐卡独立处理。
- 工具调用卡片是设计重点：agent 调 `music_play_now` 时展示将要播放的曲目列表，**执行前确认**（写类工具默认要确认，设置可关）；
- 视觉沿用「听音室」体系：对话气泡用 panel/groove，agent 思考中的读数用 `font-readout`，工具执行态可用 amber（声音正在发生的引申义：动作正在发生）。

## 6. 里程碑（A 线，插入 docs/06）

- **A0 工具面 + Port（无 LLM 依赖）✅ 2026-09-19**：`service/agent/tools.ts` 工具注册表（纯 Effect，可直接单测/集成测）+ `AgentService` 接口 + 空实现；`bun run check` 全绿。这是「AI-native 重构」的地基，可独立合并。
- **A1 内嵌宿主 ✅ 2026-09-19**：`embedded.ts`（SDK Promise 边界 + music 插件 + scratch Location + 独立 sqlite 会话库 `data/agent-sessions.db` + 内联 provider 配置）+ `/api/v1/agent` group + SSE 事件流 + 集成测试（真 SDK 宿主 + mock OpenAI 兼容 provider：工具分发 → 身份反查 → 真库执行 → 结果回传 → 回复，全链）；
- **A2 Web 聊天 ✅ 2026-09-19**：`apps/web/src/agent/`（store + 抽屉）：SSE 单例懒连接、`message.updated` 流式渲染、工具活动状态条（tool.input/success/failed 事件）、clientAction 确认卡片（play_now/enqueue 结果经确认后拉全量 Track 本地执行）、会话切换/新建/打断；侧栏「音乐助手」入口 + Ctrl+J；真实模型（OpenCode Zen / glm-5.3-flash，当时所用）端到端验证；
- **A3 画像槽位 + 探索面 ✅ 2026-09-19**（方案两次转向后的落地形态，见 §7 决策 5-7）：收听画像经 **instruction 槽位**注入（`sessions.instructions.entry.put`，缓存友好）+ `music_facets` 库词表工具 + `music_search` 结构化过滤（genre/年代/artistId/sortBy=plays）+ **music-exploration 探索技能**（skill 文件，热刷新，教 agent 自主探索与可解释推荐）。
  - ~~原案：pgvector 语义检索 + `session.hook("context")` 画像注入~~（均被否决，理由见 §7）

## 7. 决策记录与开放问题

已决策（2026-09-19）：

1. **会话持久化 = SQLite 落盘**：`data/agent-sessions.db`，专用文件，不与宿主机正在运行的 OpenCode 服务共库（隔离论证见 §3.3）；
2. **凭据 = 独立配置**：`config.content` 内联，provider key 来自 OpenMusic 自己的配置面，不复用 `~/.config/opencode`；
3. **首个真实 provider = OpenCode Zen**（`https://opencode.ai/zen/v1`，OpenAI 兼容）：`data/agent-config.json` 定义 provider+model（glm-5.3-flash，capabilities.tools 显式开），key 走 `{env:OPENMUSIC_ZEN_API_KEY}`（apps/server/.env）。（历史记录：静态 Key 方案已在公开版移除，凭据现于管理页配置 provider。）

追加决策（2026-09-19，A3）：

4. ~~**A3 = pgvector 语义检索**~~ → **否决**（用户决策）：不引入 embedding——不做向量回填任务、不换 db 镜像、不加 embedding API key、检索期零外部调用。「语义理解」上移给会话中的 LLM（多语言翻译 + 关键词变体规划本来就是它的强项），DB 侧只补结构化检索面（facets/过滤）与事实数据面（plays 画像）。docs/03 §2.11 的 `embedding` 列预留保留不动，将来想做随时可加（与现方案不互斥）；
5. **动态上下文一律走 instruction 槽位，禁止动态 system 注入**（用户决策，缓存纪律）：OpenCode 的 instruction 机制 = 会话级 key→JSON 槽位（宿主 sqlite，按会话隔离）+ 内容 hash diff——**值没变 delta 为空（零 token、前缀缓存无损）；变了只追加一条 "changed and supersedes" 增量块，system 前缀永不重写**。SDK 面：`host.sessions.instructions.entry.put/remove`（HTTP 面 `/api/experimental/session/:id/instructions/entries/:key`）。画像（`listening-profile` 键）在 prompt 前同步 put；**画像内容必须 hash 稳定**（键名固定/数组定长上限/不含绝对时间戳——见 PlayRepo.profile 注释），口味没变就零成本；
6. ~~**`music_recommend` 工具**~~ → **否决**（用户决策）：不提供推荐接口——推荐是 agent 自己的推理过程，平台提供探索原料（facets/过滤搜索/播放数据），方法论用 **skill** 教（`agent-home/skills/music-exploration/SKILL.md`，config directory 下自动发现 + Watcher 热刷新，seed 只在文件不存在时写、手改不冲）；
7. **skill 正文懒加载**：上下文里只有 name+description（稳定，缓存友好），模型按需调 skill 工具读正文——探索方法论的迭代不产生缓存代价。

仍开放：

1. TUI 接入时点（暂缓，API 就绪即可平移）。
### 交互式提问（Android 0.1.12 / Web）

`question` 是内嵌 SDK 原生的直接工具；`music` 的权限需允许该动作。助手需要用户选择时，SDK 在当前执行中等待表单，不向 inbox 追加一条伪用户消息。播放确认和物理删除确认仍是独立流程。

- 属主通过 `GET /api/v1/agent/sessions/:id/inbox` 的 `questions` 恢复待答卡片（切换会话、刷新、SSE 重连）。SSE `questions.changed` 只通知该用户刷新；不转发原始表单、授权信息、答案或工具载荷。
- `POST /api/v1/agent/sessions/:id/questions/:formId` 提交 `{ "answers": [["原版"], ["摇滚", "自填风格"]] }`；每项按原顺序对应一个问题，单选一项、多选至少一项。`DELETE` 同路径取消，不代表同意。只处理当前会话待答的原生 question 表单，不代答 MCP 或供应商授权表单。
- 回答后历史只投影该工具的题干和答案。待答表单归 SDK 活跃执行所有，客户端重连可恢复；不在服务端重启后伪造可提交的旧表单。
