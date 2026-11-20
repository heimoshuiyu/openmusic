# OpenMusic

自托管音乐流媒体服务器。索引磁盘音乐库，提供 Web 播放器与 API，兼容 Subsonic 客户端（首要适配 [Feishin](https://github.com/jeffvli/feishin)）。

- **后端**：Bun + [Effect](https://effect.website) + `@effect/platform` + PostgreSQL（`@effect/sql-pg`）
- **前端**：React 19 + Vite + TanStack Router/Query + TailwindCSS
- **兼容**：Subsonic API 1.16.1 + OpenSubsonic 协商

## 功能

- **Web 播放器**（`apps/web`）：浏览 / 搜索（CJK trigram）/ 播放列表 / 收藏评分 / 播放历史 / 歌词面板
- **Subsonic 兼容层**（`/rest`，docs/05）：Feishin 等生态客户端接入
- **Android 客户端**（`apps/android`，Kotlin + Compose + Media3）：后台播放、封面缓存、内置 AI 助手与离线单曲缓存
- **TUI 客户端**（`apps/tui`）
- **AI 音乐助手**（`docs/08`）：SSE 对话 + 13 个曲库工具（MCP，vendored OpenCode SDK），可改歌词/查库/听写
- **YouTube 导入**（yt-dlp）：音频 + 人工字幕 + 元数据；按物理版本入库、支持确认式物理删除
- **网易云音乐导入**（yt-dlp 匿名）：搜索/单曲/歌单/专辑/歌手热门，原文+翻译歌词自动入库；VIP/付费歌曲明确跳过，下载后时长校验防试听片段
- **音频流**：ffmpeg 直传/按需转码 + Range 断点续播；CUE 整轨虚拟分轨；同专辑多版本（canonical）管理

## 前置要求

- Bun 1.x
- PostgreSQL 17（下方 compose 提供，亦可自备）
- ffmpeg / ffprobe（封面提取、转码、测试 fixture 必需）
- 仅 YouTube/网易云导入需要：PATH 上的 `yt-dlp`，以及可 `import mutagen` 的 python3（容器内已内置）

## 快速开始（开发）

```bash
cp .env.example .env
# 编辑 .env：设置 POSTGRES_PASSWORD（建议 openssl rand -hex 24），并填写对应的 DATABASE_URL
set -a; . ./.env; set +a
podman compose up -d db   # PostgreSQL 17（127.0.0.1:5433）
bun install
bun run dev               # :3000（空库首启创建管理员；未设密码时随机生成并打印一次）
bun run dev:web           # :5175（Vite，自动代理 /api /rest）
```

> Vite（5175）与 Postgres（5433）只监听回环；后端 dev 默认 `HOST=0.0.0.0:3000`（局域网可达，注意所在网络）。其他设备访问方式见运行手册。

健康检查：`curl localhost:3000/api/v1/system/health`

## 生产部署（podman compose）

```bash
podman compose up -d --build   # db + app（:3000，serve 前端构建产物）
# 按需在 compose.yaml 的 app.volumes 挂载音乐目录（只读）
# 未设 OPENMUSIC_ADMIN_PASSWORD 时，首启随机管理员密码打印在 `podman logs openmusic-app`（仅一次）
# app 端口默认只绑 127.0.0.1：从局域网/其他设备接入需改 compose.yaml 的 app.ports（并置于 TLS 反代之后）
# 首次登录 admin → 管理页添加音乐文件夹 → 触发扫描
```

## 客户端接入（Subsonic / Feishin）

- 服务器地址：`http://<host>:3000`（compose 默认只绑回环，远程接入需改 `app.ports` 绑定）
- 认证：token+salt（默认）或 legacy 明文均可
- 兼容范围见 [docs/05](./docs/05-subsonic-compat.md)

## Android 客户端

```bash
bun install                        # 前置：preBuild 会用 bun 把 web 助手资产打进 APK
cd apps/android && ./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

release 签名读取 `apps/android/keystore.properties`（指向 `openmusic-release.jks`；两者均被 git 忽略）。缺省时 `assembleRelease` 产出 unsigned APK——自建 keystore 后按 `app/build.gradle.kts` 读取的字段名填写即可。

## 测试

```bash
podman compose up -d db
podman exec openmusic-db createdb -U openmusic openmusic_test 2>/dev/null || true
export OPENMUSIC_TEST_DB_URL="postgres://openmusic:${POSTGRES_PASSWORD}@127.0.0.1:${OPENMUSIC_DB_PORT:-5433}/openmusic_test"
bun test                # 只在专用测试库运行，会清空测试数据
bun run test:coverage   # lcov 报告 → coverage/
```

集成测试用进程内 `HttpApiBuilder.toWebHandler`（不起端口）+ 真实 Postgres + ffmpeg 生成的 CJK fixture，全链路覆盖：认证 → 扫描 → 浏览/搜索 → 收藏/播放记录 → 播放列表 → 流/转码/Range/封面 → Subsonic 兼容层 → 权限隔离 → 登出。

## 备份

```bash
podman exec openmusic-db pg_dump -U openmusic openmusic > backup.sql   # 数据库
tar czf data.tgz ./data                                               # 封面缓存 + secret.key（必须备份，否则 Subsonic 认证失效）——dev 布局
# 生产（compose）下 DATA_DIR 在 openmusic-data 卷内：
podman exec openmusic-app tar czf - -C /data . > data.tgz
```

## 文档

设计文档在 [`docs/`](./docs/)（事实源）：

1. [总览与决策记录](./docs/01-overview.md)
2. [架构](./docs/02-architecture.md)
3. [数据模型](./docs/03-data-model.md)
4. [第一方 API](./docs/04-api-design.md)
5. [Subsonic 兼容层](./docs/05-subsonic-compat.md)
6. [路线图](./docs/06-roadmap.md)
7. [运行手册（Runbook）](./docs/07-runbook.md) —— 启动/凭据/环境变量/备份/排障
8. [AI 音乐助手](./docs/08-ai-agent.md) —— vendored OpenCode SDK 集成、music 工具面、听写

Agent 开发说明：见 [AGENTS.md](./AGENTS.md)。

## 状态

✅ **MVP 已达成**（M0–M4 全部完成，见 [路线图](./docs/06-roadmap.md)）。歌词已落地（sidecar lrc + 内嵌标签、绑定/编辑 API、AI 助手 MCP、前端歌词面板）。后续：P1（分享/gapless/服务端队列）。
