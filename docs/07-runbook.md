# OpenMusic 运行手册（Runbook）

> 部署示例：启动、凭据、环境变量、端口、备份、排障。私有地址、代理和密码放在本机配置中。
> 设计层面的问题看 01–06；agent 开发规范看根目录 `AGENTS.md`。

## 1. 默认端口与配置

| 项 | 值 | 说明 |
|---|---|---|
| PostgreSQL | **127.0.0.1:5433** | 通过 `OPENMUSIC_DB_PORT` 覆盖映射端口 |
| 后端 dev | **:3000** | `bun run dev`（watch） |
| 前端 dev | **127.0.0.1:5175** | 需要其他设备访问时可在 `apps/web/.env.local` 设置 `OPENMUSIC_WEB_HOST` |
| 开发代理 | 默认不设置 | 在用户环境或本地 `bunfig.toml` 配置，不提交代理地址 |
| 数据库容器 | `openmusic-db` | `docker.io/library/postgres:17-alpine`，卷 `openmusic-pgdata` |

## 2. 启动 / 停止

### systemd user 服务（可选）

如果已自行安装同名用户服务，可用下列命令管理。服务应指定仓库工作目录及私有环境文件。

```bash
systemctl --user status openmusic-server openmusic-web   # 看状态
systemctl --user restart openmusic-server                # 重启后端
journalctl --user -u openmusic-server -f                 # 跟日志（原 /tmp 重定向作废）
# 服务文件：~/.config/systemd/user/openmusic-{server,web}.service（dev watch 模式）
```

### 开发模式（手动起，仅调试时用）

```bash
# 从仓库根目录运行；先按 README 设置 .env
podman compose up -d db                                # ① 数据库
bun install                                             # ② 依赖（首次）
bun run dev                                             # ③ 后端 :3000（空库首启引导）
bun run dev:web                                         # ④ 前端 :5175（另开终端）
```

### 生产模式（podman compose 单端口）

```bash
podman compose up -d --build    # db + app（:3000，内嵌前端构建产物）
```

### 停止

```bash
pkill -f "server/src/main[.]ts"   # 后端（注意：模式里别含 "bun apps/server" 字样，会误杀自己的 shell）
podman compose stop db            # 数据库（数据保留）
```

## 3. 凭据信息

| 用途 | 来源 | 说明 |
|---|---|---|
| 管理员 | `OPENMUSIC_ADMIN_*` | 仅在空库时创建；修改环境变量不会给已有账号改密 |
| 集成测试 | `OPENMUSIC_TEST_DB_URL` | 独立的临时测试库，测试账号与真实账号分开 |
| Feishin 接入 | 本人的 OpenMusic 用户名与密码 | 使用部署者提供的服务地址 |

**生产部署必须**：设 `OPENMUSIC_ADMIN_PASSWORD` 为强密码（或首启后立即改密），并配置反代/TLS。

密码存储机制（见 docs/03 §2.6）：
- 第一方登录：argon2 哈希（`Bun.password`）
- Subsonic token 认证：需要可逆取回明文 → AES-256-GCM 密文存 `users.subsonic_token_seed`
- 加密密钥：环境变量 `OPENMUSIC_SECRET`（≥16 字符），缺省首启生成 `DATA_DIR/secret.key`
- ⚠️ **丢失 secret.key 的后果**：所有用户的 Subsonic token/enc 认证失效（需重设密码），第一方登录不受影响

## 4. 环境变量速查（完整表见 docs/02 §7）

| 变量 | 默认 | 备注 |
|---|---|---|
| `PORT` / `HOST` | 3000 / 0.0.0.0 | |
| `DATABASE_URL` | 无 | 开发时显式设置；容器内由 Compose 注入 |
| `DATA_DIR` | `./data` | 封面缓存 + secret.key，**要备份** |
| `TRANSCODE_CACHE_DIR` | `/tmp/openmusic/transcode` | 重启即清，可再生 |
| `OPENMUSIC_ADMIN_USER/PASSWORD` | admin / 随机（打印一次） | 仅 users 表为空时生效 |
| `OPENMUSIC_SECRET` | — | 生产环境建议显式设置 |
| `MUSIC_FOLDERS` | — | 首启种子（逗号分隔），之后走管理 API |

## 5. 测试

```bash
podman compose up -d db
podman exec openmusic-db createdb -U openmusic openmusic_test 2>/dev/null || true   # 一次性
# 指定 OPENMUSIC_TEST_DB_URL 指向独立、可清空且库名以 _test 结尾的数据库
bun test
bun run test:unit        # 免数据库
bun run test:coverage    # lcov → coverage/
```

## 6. 备份 / 恢复

```bash
# 备份
podman exec openmusic-db pg_dump -U openmusic openmusic > backup-$(date +%F).sql
tar czf data-$(date +%F).tgz ./data        # secret.key + 封面（必须）

# 恢复
cat backup-2026-09-15.sql | podman exec -i openmusic-db psql -U openmusic openmusic
```

## 7. 排障速查（坑索引）

| 症状 | 原因 → 处置 |
|---|---|
| `bind: address already in use` | 检查本机监听端口和端口转发配置 |
| bun install 卡住 | 代理问题 → 确认 `bunfig.toml` 的 `https-proxy`，或临时 `HTTPS_PROXY=... bun install` |
| git commit 卡在 gpg pinentry | 检查个人 Git 签名与终端配置 |
| Subsonic 客户端全部 40 | secret.key 变更/丢失 → 重设用户密码（重写密文） |
| Feishin 连不上 | 检查防火墙放行 3000；地址不要写 localhost（用主机 IP） |
| 扫描无结果 | 管理页确认文件夹路径存在且可读；查看 scan-status 的 errors |
| 远程音乐目录无响应 | 先检查挂载状态与网络；恢复挂载后再尝试读取，不要在路径不可读时强制扫描。 |
| 集成测试 42P01（表不存在） | 先跑 `createdb`；helpers 的 migrateTestDb 会自动建表 |
| 集成测试 Subsonic 全 500 | users 表残留旧密文（dataDir 随机导致）→ 已由 beforeAll 全清修复；若复现，`truncate users cascade` 后重跑 |
| 转码无输出 | 确认 ffmpeg 在 PATH（`ffmpeg -version`） |
| 流式播放中途冻住（无 error、封面照转） | Bun.serve 默认 10s 空闲掐线：浏览器读满 ~16MiB 水位暂停读取即中招 → 服务端已设 `idleTimeout: 0`（main.ts）；可用 `SERVER_IDLE_TIMEOUT` 覆盖。客户端另有 5s 冻结自愈兜底（store.ts watchdog） |

## 8. 文档地图

| 文档 | 内容 |
|---|---|
| `README.md` | 项目简介 + 快速开始 |
| `AGENTS.md` | **agent 开发规范**：命令、目录、Effect 踩坑全集 |
| `docs/01-overview.md` | 定位、核心决策（D1–D8） |
| `docs/02-architecture.md` | 分层、Effect 架构、配置项、部署 |
| `docs/03-data-model.md` | ER 图、表结构、Subsonic 凭据方案 |
| `docs/04-api-design.md` | 第一方 REST API 规范 |
| `docs/05-subsonic-compat.md` | Feishin 调研 + 兼容层规范 + 验收清单 |
| `docs/06-roadmap.md` | 里程碑状态（M0–M4 ✅）与 P1/P2 |
| `docs/07-runbook.md` | 本文 |
