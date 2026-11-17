# OpenMusic

自托管音乐流媒体服务器。索引磁盘音乐库，提供 Web 播放器与 API，兼容 Subsonic 客户端（首要适配 [Feishin](https://github.com/jeffvli/feishin)）。

- **后端**：Bun + [Effect](https://effect.website) + `@effect/platform` + PostgreSQL（`@effect/sql-pg`）
- **前端**：React 19 + Vite + TanStack Router/Query + TailwindCSS
- **兼容**：Subsonic API 1.16.1 + OpenSubsonic 协商

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

> 开发默认使用回环地址，Vite 监听 5175，Postgres 映射 5433。其他设备访问方式见运行手册。

健康检查：`curl localhost:3000/api/v1/system/health`

## 生产部署（podman compose）

```bash
podman compose up -d --build   # db + app（:3000，serve 前端构建产物）
# 按需在 compose.yaml 的 app.volumes 挂载音乐目录（只读）
# 首次登录 admin → 管理页添加音乐文件夹 → 触发扫描
```

## 客户端接入（Subsonic / Feishin）

- 服务器地址：`http://<host>:3000`
- 认证：token+salt（默认）或 legacy 明文均可
- 兼容范围见 [docs/05](./docs/05-subsonic-compat.md)

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
tar czf data.tgz ./data                                               # 封面缓存 + secret.key（必须备份，否则 Subsonic 认证失效）
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

Agent 开发说明：见 [AGENTS.md](./AGENTS.md)。

## 状态

✅ **MVP 已达成**（M0–M4 全部完成，见 [路线图](./docs/06-roadmap.md)）。后续：P1（分享/歌词/gapless/服务端队列）。
