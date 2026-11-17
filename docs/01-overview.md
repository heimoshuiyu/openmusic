# OpenMusic 设计文档 —— 总览

> 版本：v0.1（2026-09-14，基于 grilling session 决策编写）

## 1. 项目定位

OpenMusic 是一个**个人自托管音乐流媒体服务器**：索引磁盘上已有的音乐文件，提供网页播放器和 API，并兼容 Subsonic 生态客户端（首要目标：Feishin）。

本项目的定位是全新实现，与历史项目 `msw-open-music`（Go + SQLite）无继承关系，但吸取其经验：
- 音乐库来自磁盘上已存在的文件（不管理下载）
- 转码流式播放是核心能力（大量无损文件 + 移动设备场景）
- 多用户、单管理员

## 2. 核心决策（来自设计访谈，已收敛）

| # | 决策点 | 结论 |
|---|--------|------|
| D1 | Subsonic 兼容目标 | Subsonic API 1.16.1 + OpenSubsonic 检测，**首要适配 Feishin**（XML/JSON 双格式输出，实际 Feishin 只用 JSON） |
| D2 | API 架构 | **第一方 REST API（`/api/v1`）为主**，按自身需求设计；Subsonic `/rest/*` 只是兼容适配层，两者共享同一核心 service 层 |
| D3 | MVP 功能 | 浏览 / 搜索 / 流播放 / 封面 / 收藏 / 评分 / 播放列表 / scrobble；**砍掉** podcast、chat、video；shares 为 P1；internetRadio / bookmarks / jukebox 缓做 |
| D4 | 扫描器 | 通用设计；mtime+size 增量；**仅手动触发**（API/Subsonic startScan），不做定时扫描、不做 inotify |
| D5 | 转码 | **必须**。ffmpeg 实时转码 + 磁盘缓存（默认 `/tmp`），LRU 淘汰 |
| D6 | 用户模型 | 多用户数据模型，单管理员，无公开注册（管理员创建用户） |
| D7 | 技术栈 | Bun + Effect 全家桶 + PostgreSQL（podman 容器） |
| D8 | 搜索 | MVP 用 `ILIKE` + `pg_trgm` GIN 索引（CJK 友好）；预留 AI 语义搜索扩展点（P2，见 6.3） |

## 3. 目标与非目标

### 3.1 目标（MVP）

- 索引多个音乐文件夹，增量扫描，提取标签（ID3/Vorbis/FLAC/MP4）与封面
- 第一方 REST API：完整的浏览、搜索、收藏、播放列表、播放记录能力
- 音频流：直传 + ffmpeg 转码（格式/码率参数）+ 转码缓存
- Subsonic 兼容层：Feishin 可以正常连接、浏览、搜索、播放、收藏、scrobble
- Web 播放器 SPA：登录、浏览、搜索、播放队列、播放列表、收藏
- 多用户：管理员管理用户，各用户独立的收藏/评分/播放记录/播放列表

### 3.2 非目标

- 不做音乐下载/获取（不是下载器）
- 不做 podcast、video、chat
- 不做歌词刮削（本地歌词文件/内嵌歌词解析属 P1）
- 不做 DLNA / UPnP
- 不追求覆盖全部 100+ Subsonic 端点（只做 Feishin 实际用到的 + 少量余量，见 `05-subsonic-compat.md`）
- MVP 不做：gapless、ReplayGain、音频可视化（P1/P2 再议）

## 4. 优先级路线

| 阶段 | 内容 |
|------|------|
| **MVP** | 扫描、第一方浏览/搜索 API、认证、流播放+转码、封面、收藏/评分、播放列表、scrobble、Subsonic 层（Feishin 全功能可用）、Web 播放器基础版 |
| **P1** | 分享（shares/公开链接）、歌词（lrc + 内嵌 + OpenSubsonic songLyrics）、gapless、服务端播放队列（indexBasedQueue）、reportPlayback |
| **P2** | AI 语义搜索（pgvector）、internetRadio、ReplayGain、智能播放列表、书签 |

## 5. 术语表

| 术语 | 含义 |
|------|------|
| **Music Folder** | 音乐库根目录（可配置多个），扫描的单位 |
| **Track / Album / Artist** | 从文件标签提取出的实体，`album_artist`（专辑归属）与 `artist`（音轨艺术家）区分 |
| **Annotation** | 用户维度的附加数据：收藏（starred）、评分（rating） |
| **Scrobble** | 播放记录上报（一次有效收听） |
| **Transcode** | ffmpeg 将原始音频转为指定格式/码率的流 |
| **第一方 API** | `/api/v1/*`，本项目自行设计的 REST API，前端的唯一后端 |
| **Subsonic 层** | `/rest/*view`，兼容适配层，仅服务 Subsonic 客户端 |

## 6. 关键取舍说明

### 6.1 为什么第一方 API 优先、Subsonic 只做兼容层

Subsonic 协议的接口形状（GET-only、query 参数、松类型、XML 优先）与现代前端需求错位。若前端直接消费 Subsonic 接口，会把协议的历史包袱内化到整个前端。因此：核心域模型 + service 层设计以自身需求为准，对外暴露两个薄适配层：

```
                    ┌──────────────┐
   Web SPA ────────▶│  /api/v1/*   │──▶ HttpApi DSL（typed + OpenAPI）
                    ├──────────────┤
   Feishin 等 ─────▶│  /rest/*view │──▶ HttpRouter（Subsonic 适配）
                    └──────┬───────┘
                           ▼
                  核心 Service 层（Effect）
                           ▼
                    PostgreSQL / 文件系统
```

### 6.2 为什么转码缓存放 `/tmp`

转码产物是可再生的高速缓存，丢失无代价。放 `/tmp`（通常是 tmpfs 或重启即清空）+ 容量上限 LRU 淘汰，避免撑爆磁盘。可通过 `TRANSCODE_CACHE_DIR` 改为持久目录。

### 6.3 AI 搜索的扩展点

搜索接口在设计上保持 `q + filter` 形状，P2 引入 pgvector 做语义召回时，仅需：
1. 扫描时（或离线任务）生成 embedding 存入 `tracks.embedding`
2. 搜索 service 内做 混合召回（trigram 召回 ∪ 向量召回 → 重排）
API 形状不变，前端无感。

## 7. 相关文档

- `02-architecture.md` —— 技术栈、分层、Effect 架构、配置、部署
- `03-data-model.md` —— ER 图、表结构、迁移策略
- `04-api-design.md` —— 第一方 API 规范
- `05-subsonic-compat.md` —— Feishin 调研结论与兼容层规范
- `06-roadmap.md` —— 里程碑拆解与验收标准
