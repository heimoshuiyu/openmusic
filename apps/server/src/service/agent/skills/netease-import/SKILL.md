---
name: netease-import
description: 从网易云音乐导入歌曲、歌单、专辑或歌手热门曲目时使用；含 VIP/付费行为、25 首上限、时长校验与可选自建实例（兼容 NeteaseCloudMusicApi 协议）的说明。
---

1. **来源选择**：用户给出 music.163.com 链接、点名「网易云/网易/163」，或想要华语/日韩主流发行的录音室版本时用网易云导入；视频、现场、自唱、播客仍走 YouTube 导入。两个工具不会替用户跨来源重复导入已入库的歌曲。
2. `tools.netease.search_netease({query})` 只搜不下载，返回 `{title,artist,album,songId,url,vip}`；`vip:true` 是 VIP/付费曲目，匿名模式拿不到完整版，导入前先告知用户。确认后 `await tools.netease.start_import_netease({url,folderId,subdirectory?})` 等到终态再回复，如实报告 `state`、数量、`trackIds`、`failures` 与 `warnings`。目标目录与来源无关，用 `tools.youtube.list_folders` / `tools.youtube.list_subdirectories` 选择；用户明确指定的目标不可写或不存在时在对话中澄清。
3. **范围与上限**：支持单曲、歌单、专辑、歌手热门四种链接；歌单/专辑最多 25 首，超过会整组拒绝并提示分批或逐首导入；歌手热门超过 25 首只导入前 25。逐首独立处理，一首失败继续其余，`failures` 逐条给出原因。
4. **VIP 与试听防护**：服务器未配置 `NETEASE_API_BASE`（匿名 yt-dlp，MP3 至多 320k）时，VIP/付费歌会在 `failures` 里标注「配置 NETEASE_API_BASE 后可重试」并跳过，不会下载残缺片段；下载后还会用 ffprobe 核对实际时长，疑似 30 秒试听片段直接丢弃不入库。配置了自建实例（兼容 NeteaseCloudMusicApi 协议）时这些歌照常尝试，成败由实例与时长校验决定；音质档位取服务器 `NETEASE_QUALITY` 配置，我们服务器不接触用户的网易云 cookie——账号配置在用户自己的实例上（建议小号，2024-10 曾有第三方登录封号潮）。
5. **入库内容**：导入成功自动内嵌网易云元数据（曲名/歌手/专辑/发行日/封面，发行日作为专辑年份）并写 `netease_imports` 溯源；原文与翻译歌词（若有）自动存进曲库歌词，歌词失败只是 `warnings`，不影响音频。文件名 `Netease-<songId>.mp3|flac`，同目录同 ID 已有文件标记 `skipped` 不覆盖；想要更高音质请让用户换目录或先移除旧文件。
