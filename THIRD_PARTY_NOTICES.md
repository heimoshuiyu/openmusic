# Third-party notices

OpenMusic 自身以 MIT 许可发布（见根目录 LICENSE）。本文件汇总随源码分发的第三方组件及其许可；
构建时引入的依赖（npm、apt、pip）许可由各自分发渠道携带。

## 随仓库分发的组件

### vendored OpenCode SDK（`vendor/opencode/*.tgz`）

- 12 个 npm 包，构建自 OpenCode SDK 的 MIT 源码；每个 tgz 内随附 `package/LICENSE`
  （Copyright (c) 2025 opencode）。
- 基线为 fork 提交 `dc80c8817d5809e982a07e976705ca7588222ced`，溯源与补丁说明见
  `vendor/opencode/README.md` 与 `headless-pty.patch`。
- core 包内嵌 models.dev 公开目录快照（`package/src/models-dev/snapshot.txt`），
  上游为 MIT（Copyright (c) 2025 models.dev）。

### Inter 字体（SIL Open Font License 1.1）

- Android：`apps/android/app/src/main/res/font/inter_variable.ttf`（Inter Variable 4.001）。
- Web：`@fontsource-variable/inter` npm 包（构建时由 Vite 拷贝 woff2 进 dist）。
- 许可文本随两端分发：`apps/android/app/src/main/assets/licenses/inter-OFL-1.1.txt`、
  `apps/web/public/inter-OFL-1.1.txt`。

## 运行时引入（不随仓库分发，构建/部署时自取）

- **npm 依赖**：MIT / Apache-2.0 / ISC / BSD-2 / BSD-3 / 0BSD / BlueOak-1.0.0 /
  Unlicense（isbot）/ CC0-1.0 为主；lightningcss 为 MPL-2.0（文件级，不传染本项目源码）。
- **Android 依赖**：AndroidX / Jetpack Compose / Media3 / Coil / OkHttp / Kotlin 系均为
  Apache-2.0；JUnit 4（EPL-1.0）仅用于测试，不进 APK。
- **容器工具链**（`Containerfile`）：
  - yt-dlp：Unlicense；Pillow：MIT-CMU。
  - mutagen：GPL-2.0-or-later，由 `apps/server/src/service/youtube/tag_media.py`
    在运行时直接 import（随 `yt-dlp[default]` extra 装入 venv）。
  - ffmpeg：GPL/LGPL（Debian 构建），仅作为子进程调用，不构成代码链接。
  - 源码仓库的分发不触发上述 GPL 义务；若构建并**分发预构建镜像**，请自行履行
    对应许可的义务（含镜像内 GPL 二进制的来源声明）。
