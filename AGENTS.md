# AGENTS.md — OpenMusic

自托管音乐流媒体服务器：Bun + Effect + PostgreSQL，第一方 REST API + Subsonic 兼容层（面向 Feishin）+ React Web 播放器。

**动手写代码前，先读 `docs/` 下的设计文档**（尤其是 02-architecture 与你要改的模块对应的那篇）。任何偏离文档的实现，要么先改文档，要么在 PR 里说明。

## 文档与信息索引

| 要查什么 | 去哪 |
|---|---|
| 启动/停止/凭据/备份/排障 | `docs/07-runbook.md`（运行手册，含本机端口与代理事实） |
| API 规范 | `docs/04-api-design.md`；OpenAPI：运行时 `/api/docs` |
| Subsonic/Feishin 兼容 | `docs/05-subsonic-compat.md` |
| 数据模型/迁移 | `docs/03-data-model.md` + `apps/server/src/db/migrations/` |
| 里程碑状态/待办 | `docs/06-roadmap.md`（M0–M4 ✅，P1/P2 未做） |
| 决策记录 | `docs/01-overview.md` §2（D1–D8） |
| 本文件 | Effect 踩坑全集在下方 Conventions |

开发端口与数据库配置见 `docs/07-runbook.md`。不要提交账号、代理或私网地址。

**运维纪律**：曲库可能位于较慢的远程挂载。触发任何扫描（包括增量或强制重扫）之前必须先征得用户同意，说明预计代价；不要随意取消进行中的扫描或重启 dev server（`bun --watch` 改服务端代码会中断扫描）。

# Learning more about Effect

This repository uses the Effect Typescript library, pinned to the **v4 rc
line** (see the version note below). The effect package ships an `AGENTS.md`
guide — read `node_modules/effect/AGENTS.md` (in apps/server) completely when
starting Effect work, and browse `node_modules/effect/ai-docs/` for runnable
examples (HttpApi / SQL / middleware / testing). When you need to verify an
Effect API, search `node_modules/effect/dist/*.d.ts` — official docs
(effect.website) mostly describe older versions; **trust local sources first**.
HTTP/SQL abstractions live under `effect/dist/unstable/http*` and
`effect/dist/unstable/sql`; Bun runtimes in `@effect/platform-bun`.

# Commands

```bash
bun install                    # 安装依赖
podman compose up -d db        # 启动 PostgreSQL 17（宿主机 127.0.0.1:5433）
bun run dev                    # 后端 watch 模式 :3000
bun run dev:web                # 前端 Vite :5175（proxy → :3000）
bun test                       # 全部测试（单测 + 类型化 handler + 集成）
bun run test:unit              # 纯函数单测（无需数据库）
bun run test:integration       # 集成测试（需 podman db + openmusic_test 库，见下）
bun run test:coverage          # 覆盖率（lcov → coverage/）

# 集成测试前置（一次性）：
podman compose up -d db
podman exec openmusic-db createdb -U openmusic openmusic_test 2>/dev/null || true
bun run check                  # tsc + lint

# 如需访问代理，请在本地环境中配置，不提交供应商凭据或内网端点。
```

**测试布局**（v4 官方姿势 + 边界补充）：
- `src/**/*.test.ts`——纯函数单测；Effect 型用 `test/effect.ts` 的 `effect()`（`it.effect` 的 bun 移植）
- `test/api.test.ts`——**HttpApiTest 内存类型化客户端**（官方 handler 测试姿势）：同请求编码/路由/解码但不过 HTTP 传输层；SessionAuth/SqlProvider 换测试实现，CurrentUser 可按用例切换身份；断言类型化结果与 `Effect.flip` 错误通道
- `test/integration.test.ts`——黑盒补充（官方姿势测不到的）：HTTP 边界（状态码/cookie/JSON 形状）、Subsonic 层、媒体流/Range、扫描器 e2e、权限隔离；`test/helpers.ts` 组装 toWebHandler 进程内服务器
- `test/effect.ts`——`@effect/vitest` 的 bun:test 移植（`layer()` 共享 Layer + `effect()`）；不用 vitest 本体是因为服务端满地 `Bun.*` API，node 运行时跑不了

# Effect 版本（重要）

锁定 **Effect 4 rc 线**（effect@4.0.0-rc.115 + @effect/platform-bun@4.0.0-rc.115 + @effect/sql-pg@4.0.0-rc.115 + @effect/platform-node-shared@4.0.0-rc.115，用户决策追最新 rc）。
v4 重组了包结构：`@effect/platform`/`@effect/sql` 包名在 v4 线**不存在**——HttpApi/HttpRouter 在 `effect/unstable/httpapi` / `effect/unstable/http`，SqlClient 在 `effect/unstable/sql`，FileSystem/Path 并入主包。
注意 `unstable/` 目录 API 仍会变；`effect` 的 npm `latest` 仍是 3.22.2，升级一律四包整体切、不夹带业务改动（见 docs/02 §Effect 版本决策）。

# Web 设计系统「唱片目录」

- 全站 `apps/web/src/index.css` 的 `@theme` 随系统切换明暗：shell / panel / raised / paper / dim / faint。参考 [OpenCode 官网源码](https://github.com/anomalyco/opencode/tree/dev/services/site) 的栏网格、等宽索引和蓝色链接，不引入官网运行时依赖。
- `components/catalog.css` 管曲库版式；`components/identity.tsx` 是唱片标识与封套；音乐助手 `agent/studio.css` 只负责对话版式。蓝色标识链接、选中态和焦点，反色实底用于主操作，红色留给错误和危险操作。
- 标题和正文用 Inter + CJK 回退，时间码、编号和路径用 `font-readout` 和 tabular 数字。
- 全屏「正在播放」保留两个设计要素：封面随播放旋转，背景随专辑封面着色。外观可随全站改版；暂停时保留转角，尊重系统减少动态效果设置。
- Web / Android 全屏唱片：80 个真实频段、10 行灰阶点阵，首尾用 15 列平滑过渡；外圈与封面同转（18 秒一圈），暂停不回正，背景不参与。Android 0.1.8 从 Media3 PCM 取样，不开麦克风；频谱和听写球在后台或减少动态效果时停止绘帧。
- 无封面专辑/艺人由 `components/cover.tsx` 程序化封面兜底（黑胶槽纹 + 首字，id 确定性生成）——网格永远有色彩层次
- 播放条=faceplate：`player/vu-meter.tsx` 是 Web Audio AnalyserNode 驱动的真信号 LED 表（`player/analyser.ts` 首播惰性建 AudioContext，`store.ts` 的 play 事件里 init）
- 音频缓存：`player/audio-cache.ts` 落 **IndexedDB**（Cache Storage/SW 在 tailnet 的 `http://` 下不是 secure context，不可用）；键=流 URL，命中 `blob:` 播放，未命中网络流起播后 8s 后台补缓存；队列抽屉底部可看体积/清空。语义与 Android `AudioCache` 对齐

# Repository layout

```
apps/server/src/
  main.ts          # Layer 组装入口
  config.ts        # 环境变量 → Effect Config
  db/migrations/   # SQL 迁移（只增不改历史文件）
  domain/          # Effect Schema（域模型）+ 带标签的错误
  repo/            # 数据访问（手写 SQL，行 → Schema 解码）
  service/         # 业务 Service（Context.Tag + Layer）
  service/agent/   # AI agent 线（docs/08）：tools.ts 工具面 / agent-service.ts Port / embedded.ts 内嵌宿主
  http/api/        # /api/v1（HttpApi DSL）
  http/subsonic/   # /rest/*.view（低层 HttpRouter + JSON/XML 序列化）
apps/web/          # React 19 + Vite + TanStack Router/Query + Tailwind
apps/tui/           # 终端客户端：@opentui/react + 原生 Audio（详见 apps/tui/src 注释与 AGENTS 的 opentui 踩坑）
apps/android/       # 安卓客户端：Kotlin + Compose + Media3（详见下方「安卓客户端」节）
packages/shared/   # 前后端共享的 Effect Schema 与常量
docs/              # 设计文档（决策的事实源）
```

依赖方向严格单向：`http → service → repo → db`。禁止 http 直调 repo、service 之间禁止循环依赖。

# Conventions

- **Effect 风格**：Service 用 `Context.Service<Self, Api>()("id")` + 静态 `layer`（`Service.of({...})` 构造）；全部业务逻辑 `Effect.gen`（可复用函数用 `Effect.fn`）；不写 async/await 业务代码
- **Effect 踩坑记录**（effect 4.0.0-rc.115 实测）：
  - `HttpApiGroup.prefix("/api/v1")` 与 **`.middleware(...)` 都必须在所有 `.add(endpoint)` 之后**调用——v4 里先 middleware 后 add 会**静默不挂中间件**（端点裸奔无鉴权，比 404 更危险）
  - `HttpApiEndpoint` 是选项对象风格：`get("id", "/path", { params, query, payload, success, error })`；handler 请求字段 **`path`→`params`、`urlParams`→`query`**；`Schema.Void` 成功值 → `HttpApiSchema.NoContent`；DELETE 端点没有 `.del`——用 `HttpApiEndpoint.make("DELETE")`
  - **v4 路由要求请求期 R = 零**：handler 函数体内不得 yield 服务——服务一律在 `HttpApiBuilder.group(Api, name, Effect.fn(function*(handlers) {...}))` 的**构建期捕获**；repo 函数请求时 yield SqlClient → 用 `middleware/sql.ts` 的 `SqlProvider`（HttpApiMiddleware `provides: SqlClient.SqlClient`，各 group 链式挂载）消化；`HttpRouter.use` 低层路由（subsonic）用捕获的 sql `Effect.provideService` 包整个 handler
  - **中间件实现层必须随各 group 层 provide**（`GroupApiLive.pipe(Layer.provide([SessionAuthLive, SqlProviderLive]))`，官方 fixture 模式）——直接 provideMerge 到 HttpApiBuilder.layer 会导致路由注册期 `Service not found`
  - **rc.115 类型噪声**：group 构建期依赖会被类型系统泄漏成 `Request<"Requires", …>` 标记进 layer R，`Layer.launch` 处类型不过但**运行时无实际需求**（集成测试全绿实证）——main.ts 有一处 cast，rc 修正后移除
  - `Effect.andThen` 只接受**返回 Effect** 的续体；纯值续体必须用 `Effect.map`（v3 的 andThen 两吃已移除）
  - 改名速查：`Effect.either`→`Effect.exit`（失败值在 `Exit.cause`）；`forkDaemon`→`forkDetach`；`catchAllCause`→`catchCause`；`Effect.catchAll`→`Effect.catch`；`Data.TaggedError`→`Schema.TaggedError`（第三个参数可直接给 `{ httpApiStatus: 404 }`，端点无需再 addError 映射状态）；`HttpServerResponse.unsafeJson`→`jsonUnsafe`；`Config.string/integer/logLevel`→`Config.String/Int/LogLevel`（值为字面量如 `"Info"`）；`Logger.withMinimumLogLevel`→`Effect.provideService(References.MinimumLogLevel, level)`
  - Schema v4 速查：`Schema.optional` 不再收 `{default}`（query 默认值在 handler `?? 兜底`）；多值字面量 `Schema.Literals([...])`（注意收**数组**）；`Schema.Union([...])` 收数组；数值范围 `Schema.isBetween({ minimum, maximum })`；过滤器必须包进 `Schema.check(...)`（`Schema.isInt()` 要**调用**）；`Schema.extend`/`minLength`/`between` 已移除
  - `HttpApiBuilder.group` 的 handler 用 `handlers.handleAll({ ...对象 })`（ai-docs 官方风格）；`Effect.fn(function*(handlers){...})` 包装
  - `import { SqlClient } from "effect/unstable/sql"` 拿到的是命名空间；Tag 值是 `SqlClient.SqlClient`；`sql.in(values)` **自带括号**；PgMigrator loader 的 `load` 必须解析为一个 Effect（v4 起 PgMigrator 还需要 FileSystem/Path/ChildProcessSpawner——由 `BunServices/BunFileSystem/BunPath` 提供，见 db/migrator.ts）
  - 扫描 fork 后 `waitScanIdle` 竞态：v4 `forkDetach` 启动有延迟，状态置位（state=scanning）必须在 **fork 之前同步完成**，否则轮询立即见到初始 idle
  - v4 收编后 @effect 双实例问题消失（platform-bun 只 peer effect 一个包）；旧 `test/fs-live.ts` 已删除
  - 测试环境 dataDir 每次随机 → secret.key 变化 → users 表残留旧 admin 的 Subsonic 密文解不开 → 集成测试 beforeAll 必须 `truncateDomainTables(true)` 后再 warmup 触发 bootstrap 重建；v4 `toWebHandler` 的 handler 带必填 context 参数（Request 标记），传 `Context.empty()` 即可
  - **HttpApiTest 套件（test/api.test.ts）两个隐性要求**：① 中间件实现层必须在 TestLayer **输出侧**（mergeAll 平级）——HttpApiTest 在 yield 处用当前 context 重建未选中组的路由；② 测试中间件里读可变状态必须 `Effect.suspend`——中间件函数在路由注册期被调用一次，不 suspend 闭包值会在构建期固化
  - **请求 payload DTO 用 `Schema.Struct` 而非 `Schema.Class`**：v4 的 Class 编码端只接受类实例——类型化客户端（HttpApiClient/HttpApiTest）从普通对象编码 payload 会 SchemaError；响应模型保留 Class（解码端无此限制）
  - **Tailwind v4 主题色命名禁止与内置工具歧义**：颜色叫 `base` 时 `text-base` 会被解析成前景色（继承内置字号工具名），标题变隐形 —— 颜色 token 起名避开 base/hidden 等（已改用 shell）
  - **自写的元素 reset 必须包进 `@layer base`**：无 layer 的 CSS 永远压过 `@layer utilities`（无视特异性）——`button { color: inherit }` 裸写会把全站按钮颜色锁死成继承色，`text-accent`/`text-shell` 等全部静默失效（白底白图标）
  - 用户浏览器里 Playwright 的 `page.screenshot` 对 fixed 元素（播放条）会拍空——是合成捕获 bug，不是代码问题；用 raw CDP `Page.captureScreenshot { captureBeyondViewport: false }` 可靠
  - **Bun.serve `idleTimeout` 默认 10s**：响应流在读端暂停读取（如浏览器媒体元素读满 ~16MiB 读-ahead 水位）时被当空闲连接掐死，且客户端无感知（媒体播放冻结、无 error 事件）。`BunHttpServer.layerConfig` 的 `ServeOptions` 即原生 Bun.Serve 选项，已传 `idleTimeout: 0` 禁用（实证 0=关闭）；长流式响应（音频/大文件/转码管道）务必留意此坑
  - **`@effect/sql-pg` 数组参数逐元素推断 OID**（rc.115 实测）：全 null 数组（`Cannot infer the type of an array containing only null values`）与 int4/int8 混装（同语句不同 OID）都会在**编码期**抛错；必须用 `PgTypes.array(values, PgTypes.OID.xxx)` 显式定型（`Result.getOrThrow` 解包），且 **int8 严格要求 BigInt 元素**（JS number 会 `Expected a bigint for int8`）。见 scanner.ts 的 `int4Array/int8Array/textArray` 辅助器。批量多行 upsert 走 `unnest(数组...)` 时另需**批内按冲突键去重**（`on conflict do update` 同语句二次命中同一行直接报错）
  - **PG 单语句 65535 参数上限**是普适约束：`sql.in(大数组)` 生成逐个占位符——批量删除/查询必须分块（scanner 的 `DELETE_CHUNK=500`）。Subsonic 目录浏览也不要全量拉路径在 TS 建树（每请求 O(全库)），下推 `select distinct split_part(...)` + LIKE 前缀（记得 `escape '\'` 转义 `%_\`）
- **sql 模板的 `{ discard: true }` 只属于 `Effect.forEach` 的第三参**——写在 tagged template 后面会被外层函数吞成实参或变成逗号表达式（静默丢结果）。v4 sql 模板本身不收 options；结果不用直接忽略即可
- **`Effect.flatMap`/`Effect.suspend` 的续体返回联合 Effect 时推断会拿首个分支定型**——异构分支（fail + 不同 E 的链）必须给续体显式返回类型注解收口（service/agent/tools.ts 有多处实例）
- **bun `.bun` 分组可能把不兼容的 peer 版本编进同组**（effect rc.112 + platform-node-shared rc.115 → `effect/ByteSize` 缺失启动即炸）——resolutions 统一版本后必须 `rm -rf node_modules/.bun && bun install` 全量重解析，只加 resolutions 不清 store 不生效
- **`typescript: "latest"` 会漂**（曾漂到 7.0.2 原生版，JSX 检查行为不同）——已钉 5.9.3；`@types/react(-dom)` 必须在 apps/web 显式声明成对版本，否则库（lucide 等）自带的 peer 实例与 JSX 解析打架（ReactElement/ReactPortal children 报错）
- **Schema-first**：请求解析、DB 行解码、响应输出共用同一 Effect Schema（放 `domain/` 或 `packages/shared`）
- **错误**：`Schema.TaggedError`（可带 `{ httpApiStatus }` 注解），HTTP 边界用 `Effect.catchTag` 精确映射；Subsonic 层映射到 Subsonic 错误码
- **SQL**：手写 SQL 放 repo 层；不用 query builder / ORM；schema 变更只新增迁移文件
- **ID**：DB 内 bigint；JSON / Subsonic 输出一律字符串；coverArt ID 带 `al-` / `ar-` / `pl-` 前缀
- **时间**：DB `timestamptz`（UTC）；JSON ISO 8601；Subsonic 输出按其惯例格式
- **副作用资源**（ffmpeg、扫描、缓存）：Layer `acquireRelease` 管理，禁止裸 Promise
- 命名：文件 kebab-case 或与现有目录一致；导出用命名导出，不用 default export
- 提交信息：conventional commits

# Domain rules to remember

## TUI 客户端（apps/tui，@opentui 0.5.8）踩坑

- **架构（v2 重设计后）**：`screens/main.tsx` = 布局（顶栏/导航轨/内容/播放面板/状态行）+ 全局键位 + 视图栈（每分区一个根视图，专辑/艺人/列表可钻入压栈，←/Esc 弹栈，选中行写回栈条目用于返回恢复）；`views/` = 各分区视图（专辑/艺人/搜索/收藏/最近/最常/播放列表/队列/随机）；`components/list-pane.tsx` = 通用列表（`ListBody` 无壳 / `ListPane` 带边框标题壳）；`rows.ts` 行构造器；`star-overlay.ts` 收藏乐观覆盖层（各视图 fetch 的 TrackSummary 是独立副本，全局 `s` 键改不了别人家的数组——会话级 Map 叠在 starred 上，失败回滚）
- **`useKeyboard` 订阅底层 emitter，聚焦 input 打字时全局 handler 照样收到**——搜索框输入期间必须用 `textMode` 状态门闸整段让路；且**空查询的 Enter 也要退出 textMode**（否则用户卡在输入模式，后续全局键全被静默吞掉，表现为「按键失灵」）
- **input 在 flex row 里宽度会塌缩成 ~2 列**（按内容自适应，空输入≈0）——外面套 `flexGrow:1` 的 box + input `width:"100%"`；**不能把 flexGrow 直接挂 input 上**（style setter 直接赋值，渲染器崩成白屏）
- **大写字母键到达时 `key.name` 归一为小写 + `key.shift=true`**（parse.keypress.ts：`A-Z → toLowerCase()`）——`case "G"` 永远匹配不上，要在一个 `case "g"` 里按 `key.shift` 分流；标点（`?` `/` `+`）保持原字符
- **渲染器接管 stderr**——`console.error/log` 全部不可见，调试用 `appendFileSync` 直写文件
- **异步列表恢复选中行**：挂载时 `setSelectedIndex` 会被随后到达的数据（options 数组替换）冲掉——要等 `options.length > 0` 的首次渲染再应用（ListBody 的 appliedSel ref）
- **必用 @opentui/react，不能用 @opentui/solid**：solid 绑定的响应式更新（signal→renderable）在 Linux 上全冻结——官方 solid 示例同样复现（输入过滤不生效），首帧后一切静态；React 绑定正常（OpenCode 生产同款）
- **OpenTUI 原生 Audio 不认 `audio/flac`**：流请求一律 `?format=mp3&maxBitRate=320` 让服务器转码（走转码缓存）；cookie 经 `playStreamUrl` 的 `request.headers` 传入
- 播放位置 = `stats.framesPlayed / stats.sampleRate` + **`baseSec` 流起点**（断点续播时 >0）（500ms 轮询）；**`Audio.create()` 必须传 `autoStart: true`**——引擎默认不自启，不启动则设备端永不消费、缓冲填满（2000ms）后永远卡 buffering（framesPlayed=0），**有声卡的机器也一样**（曾误判为"无音频设备"，实测设备枚举正常也要显式启动）；AudioStream 无暂停/seek——**暂停 = 停流前最后一读冻结位置，恢复 = `?timeOffset=` 断点重连**（服务器 ffmpeg 输入端 seek；注意流拷贝不重写 STREAMINFO，ffprobe 的 format duration 是全长，实测要解码）；**seek 同理**：播放中带偏移重连（streamGen 代数防快速连点竞态），暂停态只挪指针不起流
- **队列语义**：手动 `n` 总是回绕（可预期），自动播完走 repeat 语义（off=播完即停但保留队列与当前曲，state="ended"，space 重放当前曲）；shuffle 随机跳避开当前曲；`removeAt` 移除当前曲时播放中→补位曲从头播，暂停→补位曲以暂停态上岗（别拿旧曲位置起新曲流）
- `bun run` 会吞掉脚本 flag——TUI 一律 `bun src/index.tsx --url ...` 直跑（`bun run start -- --url` 也行）
- **mini 播放器模式**：窗口 <70 列或 <16 行自动切换（App 内 MainScreen/MiniPlayer 双挂载 + `visible` 切换，主屏状态不丢；mini 下全局键只留播放控制）；**MiniPlayer 必须自己 `usePlayerTick` 订阅**——它与 MainScreen 是兄弟节点（不是子节点），MainScreen 的 tick 重渲染带不动它，不订阅就只在窗口尺寸变化（App 重渲染）时才刷新，表现为「播放时间不动、缩放一下才更新」（v2 重构时踩过）；**歧义宽度字符（`· … ░█ ▶ ★`）在 CJK 终端按 2 列渲染**——按码点数或 1 列算截断预算必炸行，一律用 `src/text.ts` 的 `visualWidth`/`truncateVisual`/`padVisual`；**行内对齐标记一律 ASCII**（正在播放用 `>`，`★` 只放行尾——后面没有需要对齐的内容）
- **鼠标**：框架内建（renderer 默认开鼠标上报，hit-test 派发 + 事件沿 render 树冒泡），React 绑定直接写 `onMouseDown`/`onMouseScroll` 等 props（reconciler default 分支 `instance[key]=value` → Renderable setter）。已接：导航轨/列表行点击、滚轮移动选中、播放条按钮排（每项定宽定高 `<box>` 做热区）、**进度条整条是 seek 热区**（`event.x - element.x` → 比例 → seekTo）、滚轮调音量。三个坑：① 点击热区一律用**定宽定高 `<box>` 包字形**——歧义宽字符（◀▶）各终端渲染列数不同，text 热区会和视觉错位；② flex 行内不定高的 box 子项会把整行撑成 2 行溢出画到边框上（播放条按钮踩过），控制条每项 `height:1`；③ Select 的 `scrollOffset`/`linesPerItem` 是私有字段，点击换算行号走 cast 读取
- **tmux 里注入鼠标事件**：`tmux send-keys -H` 发原始字节。opentui 的 X10 解码按 **1 基坐标**（字节 = 32+1基列/行），SGR（`\x1b[<b;c;rM`）在 tmux 内可能没启用（能力协商 DECRQM `?1006$p` 未确认时回落 X10）——tmux 测试用 X10（按下=32、滚轮上=96/下=97），真实终端两种都行
- 渲染器初始化会等终端能力查询回应——自动化测试需要回应 `\x1b[6n`/DA/DECRQM 的仿真 pty（见会话历史 vt-harness），哑 pty 会首帧空白假死
- opentui 的 cookie 名是 `om_session`（不是 `session`）；TUI 的 OmApi 实例必须跨渲染稳定（useMemo），重建即丢会话
- **登录态持久化**（`src/auth-store.ts` → `~/.config/openmusic-tui/auth.json`，0600）：恢复链 = CLI 密码 → 保存的 cookie（`GET /api/v1/auth/me` 校验）→ 记住的密码静默重登 → 预填登录屏；`--logout` 清除。两个坑：① 交互登录失败时**不要把 phase 切走再切回**——LoginScreen 重挂载会把用户刚改的输入重置回预填值（登录屏期间 phase 保持 `"login"` 不动，靠 busy 挡重复提交）；② 密码明文落盘是自托管场景的取舍，别在多用户机器上用
- **播放态持久化**（`src/player-state.ts` → `~/.config/openmusic-tui/player.json`）：只记「上次曲目」（队列 TrackSummary[] + index）和音量，**不记时间点**——重开后曲目以 `"paused"` 态出现在播放条（`Player.restore()`，不起流），空格从头播；`startCurrent`/`setVolume` 时落盘（音量写盘前 round 千分位防浮点尾巴）；按 url 匹配服务器，不匹配即忽略

- Subsonic 层**不是**第一公民：新能力先进第一方 API 与 service 层，Subsonic 只做映射；未实现端点返回 `code=0` 兜底

## 安卓客户端（apps/android）踩坑与约定

- **技术栈**：Kotlin + Jetpack Compose（BOM 2026.01.00）+ Media3/ExoPlayer 1.8 + OkHttp(cookie 会话) + coil3 + kotlinx-serialization；构建：Gradle 9.4.1（wrapper 已入库）+ **AGP 9.2 内置 Kotlin**（不需要也不允许再 apply `org.jetbrains.kotlin.android`；Compose 编译器插件 `org.jetbrains.kotlin.plugin.compose` 版本须与 AGP 内置 Kotlin 同版，当前 2.3.0）。JDK 21 + SDK 36（`~/Android/Sdk`），minSdk 26 / targetSdk 36；代理放在用户级 Gradle 配置
- **构建/装机**：`cd apps/android && ./gradlew :app:assembleDebug` → `adb install -r app/build/outputs/apk/debug/app-debug.apk`；USB 调试用 `adb reverse tcp:3000 tcp:3000`（手机 localhost:3000 → 电脑服务器），真机使用自己的服务器地址
- **架构**：`OpenMusicApp` 持全局单例（OkHttp + cookieJar + api + coil ImageLoader）；`player/PlaybackService`（MediaSessionService：后台播放/通知栏/锁屏/耳机键）+ `PlayerBus`（进程内 StateFlow，UI 直读状态）+ `PlayerController`（MediaController 通道，UI 命令走它保证与通知栏一致）；`ui/MainScaffold` 底部五个一级页面（主页、资料库、音乐助手、搜索、收藏）+ MiniPlayer + NowPlaying 全屏层；屏幕间动作走 `UiActions` 协议
- **会话**：`om_session` cookie 由 `PersistentCookieJar`（DataStore 落盘）随所有请求自动携带——API/流/封面共用同一 OkHttpClient；ExoPlayer 用 `OkHttpDataSource.Factory` 共享之
- **音频流缓存（2026-10-08 起）**：`player/AudioCache` = 进程单例 `SimpleCache`（`cacheDir/audio`，**不设上限** NoOpCacheEvictor——用户决策，磁盘写满由 FLAG_IGNORE_CACHE_ON_ERROR 兜底回源）+ `CacheDataSource` 包在 OkHttp 工厂外层——重播/重听零流量；缓存键 = `<origin>/track/<id>`（纯函数 `streamCacheKey`，转码回退加 `-t`）：换服务器地址不串缓存、原始/转码两份字节流分开存；`SimpleCache` 同目录单实例，服务销毁重建**不得 release**（挂 object 常驻进程）。完整「下载离线」未做
- **曲目封面必须走 `TrackCover`/`CoverArt`（带 `trackId`）**：`track.hasCoverArt` 语义 = **自身内嵌 OR 专辑有任何封面**（含兄弟曲目内嵌，2026-09 起）——true 时请求 `tr-{trackId}` 可拿「自身内嵌 → 专辑链」的精确封面，请求 `al-{albumId}` 拿专辑统一封面；两者都自动兜底程序化占位（与 web `CoverArt` 同散列算法）。组件内部是三级回退（tr- → al- → 程序化），任何一步不得白屏
- **音乐助手（0.1.2）**：Android APK 通过 Gradle `buildAssistant` 打包 `apps/web/src/android-assistant/`，复用 Web 对话组件与 store，不在 Compose 重写时间线、inbox 或听写逻辑。原生 `AssistantBridge` 只连接 APK 资源源与有身份边界的 OkHttp；SSE 派生 client 长读，登出必须 cancel Call + 销毁端口，重连从宿主恢复。Android 只提供全屏助手，小窗仅限 Web。原生播放卡片只在用户确认后按 id 获取完整 TrackSummary。
- **版本选择器语义**：`×N` 徽标/长按「选择版本」→ `/tracks/:id/versions`（index 0 = 标准版）→ **选中副本顶替原曲起播**（`list.mapIndexed(i==idx ? version : t)` 后 setQueue——与 web 同语义，队列里这首就是用户挑的那份）
- **打点规则**（>50% 或 >240s，播完兜底）在 `PlaybackService.maybeScrobble`，与 web/TUI 判定一致；监听秒数取触发瞬间进度
- **解码失败回退**：`onPlayerError` → 同曲换 `?format=mp3&maxBitRate=320` 重试一次（每曲限一次，`transcoded` 集合防循环）
- **`setWakeMode(C.WAKE_MODE_NETWORK)` 必须声明 `android.permission.WAKE_LOCK`**——漏了会在起播瞬间 SecurityException 崩掉（播放线程，不弹窗直接死）
- **大半径 `Modifier.blur`（>~40dp）在低端 GPU（Adreno 610 实测）整个图层渲染为空**——环境晕染不要用 RenderEffect blur，改「全尺寸封面 graphicsLayer(scale 1.4, alpha 0.35) 放大铺底 + 渐变压暗」；同理 `ImageRequest.Builder.size(40)` 小图请求在该机型上也不渲染（原因未深究），直接传 URL 字符串
- **coil3 单例**：Application 实现 `coil3.SingletonImageLoader.Factory`（方法是 `newImageLoader(Context)`），Compose 的 AsyncImage 自动取用；没有 `coil3.compose.LocalImageLoader`
- **测试方式（无视觉环境）**：`adb exec-out screencap -p` + Python PIL 采样像素（背景 shell 色/红进度/白播放键/晕染均值），`adb shell uiautomator dump` + adb pull 拿无障碍树（文本/bounds）定位控件；tap 坐标从 dump 算——手猜必错
- **Compose 手写图标**：`OmIcons` 用 `addPathNodes("M2 18h1.4...")` 解析 lucide SVG path（`PathParser` 不是公开 API）；stroke/fill 参数要 `SolidColor`（`Brush`），tint 靠 Icon 的 ColorFilter 整体替换
- tab 导航 `popUpTo(start){saveState}+restoreState` 会**恢复各 tab 的钻入栈**（主页 tab 回来时带着上次钻入的专辑页）——这是预期行为不是 bug
- Feishin 能力协商由 `getOpenSubsonicExtensions` 通告列表控制——**只通告已实现的扩展**（见 docs/05 §2）
- Subsonic 认证三模式（token+salt / enc:hex / plain）依赖 `users.subsonic_token_seed`（见 docs/03 §2.6），改密码必须同事务更新该列
- 扫描是单飞的（进行中再触发 → `ScanInProgress` 错误 / Subsonic 返回当前状态）；可 `DELETE /library/scan` 幂等取消（interrupt Fiber，已提交批次保留）；大库扫描要点（unnest 批插/分块删除/艺人清扫看双引用）见 docs/02 §5；**消失清理仅在 walk 零错误的目录上执行**——远程 FS 瞬时读错误（NFS stale handle/SMB 重连）不清库，「看不见」≠「已消失」，可读部分照常索引
- **plays 是不可变事实日志（0003 墓碑设计，docs/03 §2.7）**：曲目删除 FK `SET NULL` 不级联；打点写全快照（title/artist_name/album_name/duration + `artist_id`/`album_id`——后两者是自然键 upsert 的稳定身份，跨目录重登记不漂移）；唯一写路径 `PlayRepo.record`（第一方 + Subsonic scrobble 共用，别开旁路）。消费面分工：`/plays/recent` 保留墓碑（`track: null` + 快照叙事，三端灰显不可播）；`most-played?type=track` 过滤死行、album/artist 型按快照 id 聚合（无 join）；`summary` 凭快照单调不回退。改这里先读 docs/03 §2.7 的动机段（AI 统计/推荐的数据基底）
- 转码产物是可再生缓存：可随时删除，LRU 守护进程负责不超 `TRANSCODE_CACHE_MAX_BYTES`
- **Unknown Artist/Unknown Album 是 scanner 的无标签回退身份**（常量在 `@openmusic/shared`，是数据语义的一部分，改动等于拆散存量聚合）：most-played album/artist 型排除之（track 型与 summary 不排）；文件夹封面不挂 Unknown Album 与跨多目录的专辑；封面回发降级链（文件夹 → 内嵌 → 404）任何一步不得 500
- **专辑归组推断链（VA 合辑的命门）**：albumartist 标签缺失时按「专辑目录（`util/album-grouping.ts` 剥尾碟号段）+ 专辑名」分组裁决——组内显式 albumartist 众数 → 曲作者唯一者 → `Various Artists`；碟号链 = DISCNUMBER → 父目录末段纯碟号。显式标签不被推断改写，推断只在目录内做。专辑身份与可见性分离：浏览读 `library_albums`；空专辑有播放、收藏或评分则保留原 ID，不按同名重定向（`repo/album-lifecycle.ts`）。
- **重复拷贝走 canonical_tracks 视图（docs/03 §2.5）**：同专辑多份 rip（不同来源/音质）是本库主形态——浏览面（专辑曲目/列表/随机/搜索/Subsonic song 列表）一律 canonical 口径（每槽位一份最优：无损→采样率→码率→路径短），带 `version_count`；**物理行一个不删，id 定位类查询（songById/播放列表/scrobble）严禁换源到视图**——非 canonical 的 id 在视图里不存在，换了就 404。物化计数也是 canonical 口径。**track 收藏/评分经 AnnotationRepo.canonicalizeTrackIds 归一到槽位 canonical**（收藏的是歌不是文件）；版本列表走 `/tracks/:id/versions`

## AI Agent 线（A0–A3，docs/08-ai-agent.md）约定

- **架构**：`service/agent/tools.ts` = music 工具面（12 个 `music_*` 工具，纯 Effect、走既有 repo，口径与浏览面一致）；`agent-service.ts` = Port（身份显式进 Port：非属主与不存在同回 NotFound）；`embedded.ts` 用同一宿主处理聊天与听写。`vendor/opencode/README.md` 记录 fork 的版本与升级流程；SDK 的 Effect 4.1 和 OpenMusic 的 rc.115 只通过 Promise/普通对象交互，不全局覆盖 Effect 版本。
- **隔离**：宿主会话/凭据库 = `data/agent-sessions.db`（专用 sqlite，不与宿主机 OpenCode 共库）；`config.directory` 指专用 agent-home，`config.file` 指独立 JSONC（管理页可写），`project:false` 禁止仓库配置发现。Location = `data/agent-workspace`（scratch，绝不指向仓库或 `/data`）；不得将 SDK 配置、原始 provider/model 或凭据对象返回给浏览器。
- **多用户咽喉**：PG `agent_sessions` 表记归属（0007）；工具执行期用 `sessionID` 反查 owner（工具上下文只有 sessionID）；music agent 权限 deny edit/bash/shell/write（config `agents` 字段定义——AgentEditor 没有 add）
- **OpenCode 工具的调用面由 `options.codemode` 二分**（core/tool.ts 实证）：`codemode: false` = 直接 `tool_calls`（进请求 tools 数组 + 执行器注册表）；**不设或 true = Code Mode**（只出现在 execute 沙盒目录，直接调用会 "No tool named"）。music 工具现为 **Code Mode（用户决策）**：内层调用无独立 tool.success 事件，状态经 `session.tool.progress` 的 `metadata.toolCalls` 累积上报；play_now/enqueue 的确认卡片靠服务端自产 `client-action` 事件。SSE 经 `event-bridge.ts` 按已核验属主多播，禁止直接把宿主流或全局 PubSub 暴露给客户端。
- **测试姿势**（test/agent-embed.test.ts）：本地 Bun.serve mock 一个 OpenAI 兼容 `/v1/chat/completions`（流式 + 非流式都接、含 usage 空块），插件 `ctx.provider.transform` 注册 `om-test/echo` 指过去——无 key 全链确定性（工具调用轮按「请求里有无 role:tool 消息」分流，别按调用计数：标题生成会抢轮次）
- 开关：`AGENT_ENABLED`（默认 false）+ `AGENT_CONFIG`（独立配置文件路径）；未启用全部端点 503
- **动态上下文纪律（A3 起）**：禁止往 system 注入任何每请求变化的内容（毁 KV 前缀缓存）。收听画像走 **instruction 槽位**：`host.sessions.instructions.entry.put({sessionID, key:"listening-profile", value})`，prompt 前同步 put——宿主按内容 hash diff，值没变零 token、变了只追加 "changed and supersedes" 增量（system 前缀永不重写）。**画像值必须 hash 稳定**（键名/数组上限固定、无绝对时间戳），否则每轮都触发无谓增量
- **探索技能**（recommend 接口被否决——授人以渔）：`agent-home/skills/music-exploration/SKILL.md` 由 embedded.ts 启动 seed（**不存在才写**，手改不冲），config directory 的 `skills/` 子目录自动发现 + Watcher 热刷新；上下文只进 name+description，正文模型按需读
- **music_search 探索面（A3）**：q 可省略但须至少一个结构化过滤（genre/yearFrom/yearTo/artistId，防全库扫描）；过滤只作用于 track 维度；`sortBy:"plays"` = 当前用户播放次数降序（口味信号）；`music_facets` 返回库词表（genre top-24/年代分布/top 艺人，年份清洗：>9999 取前 4 位、1900–2100 外丢弃）
