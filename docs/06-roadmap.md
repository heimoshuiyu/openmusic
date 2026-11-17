# OpenMusic 设计文档 —— 路线图

## 里程碑总览

```
M0 骨架 ──▶ M1 扫描+API ──▶ M2 流+认证 ──▶ M3 Subsonic 层 ──▶ M4 Web 播放器 ──▶ (MVP 达成)
                                                                  │
                                                    P1: shares/歌词/gapless/服务端队列
                                                    P2: AI 搜索/电台/ReplayGain

A 线（AI Agent 集成，设计见 docs/08-ai-agent.md）：
A0 工具面+Port（无 LLM） ──▶ A1 内嵌 OpenCode 宿主 ──▶ A2 Web 聊天 ──▶ A3 画像槽位 + 探索面（无 embedding，详见 docs/08 §6/§7）
```

每个里程碑的定义（DoD）：

- 代码合并主分支，`bun test` 全绿
- 集成测试覆盖新增链路
- 文档同步更新（API 变化 → 04；表变化 → 03）

## M0 — 仓库骨架与走通链路（半天~1 天）✅ 2026-09-15

- [x] bun workspaces：apps/server、apps/web、packages/shared
- [x] 根 package.json / tsconfig / .editorconfig / .gitignore / compose.yaml（postgres）/ .env.example
- [x] `@effect/sql-pg` 接入 + Migrator + 迁移 0001（全量建表，见 03 文档）
- [x] BunHttpServer 启动，`/api/v1/system/health` 与 `/rest/ping.view` 返回 ok
- [x] compose db 一键起，`bun dev` 一键跑
- 备注：宿主机 5432 被 VS Code 端口转发占用，compose 映射改为 **127.0.0.1:5433**（默认 DATABASE_URL 已同步）
- **验收**：`podman compose up -d db && bun dev` 后 curl 两个端点返回 200 ✅

## M1 — 扫描器 + 浏览/搜索 API（2~4 天）✅ 2026-09-15

- [x] music-folders CRUD + 扫描触发/状态端点
- [ ] ScannerService：遍历/diff/元数据提取/封面/物化计数（02 §5）
- [ ] repo 层 + browse 端点（artists/albums/tracks/genres/random）
- [ ] pg_trgm 索引 + `/search`
- [x] fixture 音乐文件（几首多格式）+ 扫描集成测试（ffmpeg 生成 CJK 标签曲库）
- **验收**：浏览/搜索响应 <100ms ✅（fixture 级验证；大库压测顺延到 MVP 发布前）

## M2 — 认证 + 流播放（2~3 天）✅ 2026-09-15

- [ ] users/sessions 表启用，`Bun.password` argon2，login/logout/me，会话中间件，首启管理员引导
- [ ] users 管理 API 🔒
- [ ] StreamService：直传（含 Range）、ffmpeg 转码管道、`/tmp` 缓存 + LRU 淘汰 Fiber、并发信号量
- [ ] `/tracks/:id/stream|download`、`/covers/:id`（内嵌封面提取落盘）
- [ ] 转码参数映射单测（format×bitrate → ffmpeg args）
- **验收**：curl 带 Range/转码参数拿到正确字节流；并发 8 路转码不超上限；缓存目录被 LRU 控制在配额内

## M3 — Subsonic 兼容层（2~3 天）✅ 2026-09-15

- [x] 认证三模式（token/hex/plain）✅ 全部实测通过
- [x] 响应信封 + JSON/XML 双序列化 + 错误码映射 + 未实现兜底（code=0）
- [x] 37 个 MVP 端点（05 §5.1）统一分发器实现（含虚拟目录 folder browsing）
- [x] 脚本级验收：36/36 通过（auth/浏览/搜索/star/rating/scrobble/playlist/stream/cover/scan/folder-browse/错误路径）；真实 Feishin 手工回归待用户环境验证
- **验收**：✅（Feishin 实机回归标记为发布前待办）

## M4 — Web 播放器（3~5 天）✅ 2026-09-15

- [x] Vite + React 19 + TanStack Router/Query + Tailwind 脚手架 + 手写 typed client
- [x] 登录页 + 路由守卫（beforeLoad + 401 事件全局登出）
- [x] 布局：侧栏 + 底部播放条 + 队列抽屉，暗色主题
- [x] 列表/详情页（首页/艺人/专辑/曲目）+ 搜索页（CJK 命中）
- [x] 播放器：单 audio + MediaSession；队列管理（跳转/移除/随机/单曲·列表循环）
- [x] 播放列表页（增删/移除曲目）；收藏交互（专辑/艺人）
- [x] scrobble（>50% 或 >4min 客户端判定）；管理页（用户/文件夹/扫描进度）🔒
- 备注：队列拖拽排序与曲目右键菜单并入 P1；genres 页面并入 P1
- **验收**：headless Chromium E2E 16/16 通过（登录→浏览→播放→队列→搜索→收藏→建列表→管理→登出）✅

## MVP 发布 ✅ 2026-09-15

- [x] Containerfile（两阶段：web build + bun:slim+ffmpeg）+ compose app 服务 + 静态文件服务（dist 存在才挂载）
- [x] README 快速开始
- [x] 备份说明（pg_dump + DATA_DIR，见 README）
- 遗留到发布前：真实 Feishin 手工回归、大库（≥1000 文件）性能压测

## M5 — 安卓客户端（1~2 天）✅ 2026-09-16

- [x] Kotlin + Compose + Media3 脚手架（Gradle 9.4.1 + AGP 9.2 内置 Kotlin，踩坑见 AGENTS.md 安卓节）
- [x] 登录（服务器地址 + cookie 持久化，DataStore）；设计系统移植 web v2（shell/panel/paper/accent 红唯一强调 + Inter Variable + tabular 读数）
- [x] 四 tab：主页（滑架/最近播放/随机）/资料库（专辑·艺人·播放列表分段）/搜索（即时分组）/收藏（三分段）
- [x] 专辑/艺人/播放列表详情（环境色晕染头图、播放全部、收藏、曲目长按操作面板）
- [x] 播放：后台 MediaSessionService（通知栏/锁屏/耳机键）、MiniPlayer、全屏正在播放（黑胶+唱臂+红进度+下滑收起+横滑切歌）、队列管理
- [x] scrobble（>50%/240s 同判定）；解码失败自动转码回退（?format=mp3&maxBitRate=320）
- 备注：播放列表编辑（重命名/拖拽排序）、流派浏览、下载离线并入 P1；真机全流程实测通过

## M6 — CUE 整轨虚拟分轨 + 超长时长加固 ✅ 2026-09-18

- **CUE 虚拟分轨**（docs/03 §2.8）：整轨镜像 + cue → 虚拟曲目（合成键 + offset_ms
  分段），扫描判定/编码回退链（Shift-JIS/GB 系）/边界播放（-t 卡终点）/统计/
  cue 增删自然迁移全链路；分轨自带 cue 与引用缺失镜像的 cue 无害跳过
- **超长时长加固**：ogg/opus 时长重解析兜底（快速模式不 seek 尾部 granule）；
  三端时长显示超 1h 进位 h:mm:ss；转码缓存单条目 256MiB 上限（超长曲完整
  转码纯透传不落盘）；Web 播放器解码失败换 `format=mp3` 重试一次（Safari ogg/
  opus、ape/wavpack 场景，与 Android 同款语义）

## M7 — 安卓端跟进（web/server 近三周增量平移）✅ 2026-09-20

- **音乐助手**（本里程碑的初版；0.1.1 已改为与 Web 共享对话实现，现状见 docs/08 §5）：全屏聊天（主页顶栏 Bot 入口）；原 `agent/AgentBus` 进程级
  StateFlow + OkHttp 长读 SSE（`readTimeout=0` 派生 client；断线指数退避重连；503
  unavailable 横幅不重试）；流式增量/分段校正/工具状态条/打断；client-action 卡片
  确认后本地执行（play-now/enqueue，精简投影按 id 拉全量再入队）
- **canonical 版本选择器**：`versionCount` 徽标（×N）+ 长按「选择版本」；版本表
  （codec/kHz·k/来源目录末三段，index 0 = 标准版）选中副本顶替原曲起播（web 同语义）
- **tr- 曲目封面链落地**：`CoverArt`/`TrackCover` 增 `trackId`——tr- 精确封面 → al-
  专辑统一封面 → 程序化占位分级回退（此前只走 al-，AGENTS.md 规范补齐）
- 协议面真验：SSE 帧格式/`message.delta` 平铺、raw 宿主事件嵌套 `event.data`（流
  捕获实证修正过一次层级）、`/tracks/:id`、`/tracks/:id/versions`

## M8 — 安卓音频流缓存 ✅ 2026-10-08

- Media3 `SimpleCache`（`cacheDir/audio`，不设上限 NoOpCacheEvictor，进程单例）+
  `CacheDataSource` 边播边存：重播/重听歌单零流量（此前每次播放完整重拉流）
- 缓存键按 origin + trackId 归一（`player/AudioCache` 纯函数 + 单测）：服务器地址
  变化不失效、换服务器实例不串缓存；转码回退流（`?format=mp3`）独立成键，避免
  回退后命中解码失败的原始缓存
- 完整「下载离线」（手动下载/离线歌单，Media3 DownloadService）仍不做

## P1（MVP 后，按序）

0. **扫描删除实体时级联清理 annotations/plays 孤儿**（读取侧已由 `starredIds` 的 exists 过滤兜底）

1. **shares**：公开分享链接（无鉴权只读 stream/封面，带过期）
2. **歌词**：lrc 文件 + 内嵌歌词解析；通告 `songLyrics` 扩展 + getLyricsBySongId；前端滚动歌词
3. **gapless**：双 audio 元素预加载切换
4. **服务端播放队列**：`play_queues` 表 + getPlayQueue/savePlayQueue + 通告 `indexBasedQueue`（ByIndex 变体）
5. **reportPlayback** + now-playing 列表
6. 转码 profile 每用户覆盖的管理 UI

## P2

1. **AI 语义搜索**：pgvector + embedding 生成任务 + 混合召回
2. internetRadio（表 + CRUD + 通告端点）
3. ReplayGain（扫描期分析 + 前端 gain 应用）
4. 智能播放列表（条件表达式）
5. bookmarks、artist 图片上传、多音乐文件夹隔离（musicFolderId 过滤）

## 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| Feishin 对字段形状的实际容忍度与文档不符 | M3 返工 | M3 一开始就用真实 Feishin 联调，快照测试固化 |
| @effect/sql-pg 在 Bun 下的驱动兼容性 | M0 阻塞 | M0 第一天即验证；备选：postgres.js 手写薄层适配 |
| 大库扫描内存/速度 | M1 体验 | 分批 upsert（每 500 条一事务）、并发信号量、不整库载入内存 |
| 转码缓存把 /tmp 撑爆（非 tmpfs 场景） | 稳定性 | LRU Fiber + 容量上限 + 启动时清孤儿 |
| XML 序列化细节坑（自关闭标签/属性序） | 其他客户端显示问题 | MVP 只保证 JSON（Feishin）；XML 为尽力而为 |

## 开发节奏约定

- 主分支 + 短生命周期分支；提交信息 conventional commits
- 每个 PR：`bun run check`（tsc + lint + format）+ `bun test` 通过
- 数据库 schema 变更只走新迁移文件，禁止改历史迁移
