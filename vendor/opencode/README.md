# OpenMusic 内嵌宿主发行包

`2.2.5-openmusic.1` 基于 hmsy 的 OpenCode fork `dc80c8817d5809e982a07e976705ca7588222ced`，附 `headless-pty.patch`（延迟载入可选 PTY）及打包脚本中对听写 ffmpeg 的输入格式、协议、时长限制。包含 SDK 的 12 个运行时 workspace 包，不含整个 App 或个人配置。Bun 直接执行包内 TS；类型声明由同版本源码生成。安装和运行均不访问开发者的 OpenCode checkout。

日常安装：在项目根运行 `bun install --frozen-lockfile`。归档文件名末尾是 SHA-256 前 12 位，可用 `sha256sum -c SHA256SUMS`（本目录）复核。不要单独替换 SDK 或强制它使用应用的 Effect rc.115。

打包脚本还会移除 server 听写提示中自动附加的 `directory:` 行：启用会话上下文不需要把宿主工作区路径传给模型。

重建：准备上述提交的**独立** fork 检出并安装其锁定依赖，`git apply /path/to/headless-pty.patch`，然后运行 `python3 vendor/opencode/pack.py /path/to/checkout`。有意升级时同时更新 pack 版本、所有根 resolutions 和 server 依赖、校验清单及 bun.lock；在临时数据库跑 agent-embed / agent-console 回归后再切换。不要在滚动开发目录内反复构建或发布到公共 registry。
