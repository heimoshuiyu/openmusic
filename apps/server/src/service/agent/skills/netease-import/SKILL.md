---
name: netease-import
description: 从网易云音乐导入歌曲、歌单、专辑或歌手热门曲目，或管理已导入的网易云曲目（查看/修改标签、移出曲库、连原文件删除申请）时使用；含 VIP/付费行为、25 首上限、试听片段时长校验与删除人工确认流程的说明。
---

1. **来源选择**：用户给出 music.163.com 链接、点名「网易云/网易/163」，或想要华语/日韩主流发行的录音室版本时用网易云导入；视频、现场、自唱、播客仍走 YouTube 导入。两个工具不会替用户跨来源重复导入已入库的歌曲。
2. `tools.netease.search_netease({query})` 只搜不下载，返回 `{title,artist,album,songId,url,vip}`；`vip:true` 是 VIP/付费曲目，匿名模式拿不到完整版，导入前先告知用户。确认后 `await tools.netease.start_import_netease({url,folderId,subdirectory?})` 等到终态再回复，如实报告 `state`、数量、`trackIds`、`failures` 与 `warnings`。目标目录与来源无关，用 `tools.youtube.list_folders` / `tools.youtube.list_subdirectories` 选择；用户明确指定的目标不可写或不存在时在对话中澄清。
3. **范围与上限**：支持单曲、歌单、专辑、歌手热门四种链接；歌单/专辑最多 25 首，超过会整组拒绝并提示分批或逐首导入；歌手热门超过 25 首只导入前 25。逐首独立处理，一首失败继续其余，`failures` 逐条给出原因。
4. **VIP 与试听防护**：VIP/付费歌（`vip:true`，fee∈{1,4}）在导入前的预检阶段就被明确跳过，`failures` 里说明「VIP/付费歌曲需要会员账号，未导入」——不下载残缺片段；下载后的 ffprobe 时长校验是第二道保险（容差 max(2 秒， 预期 1%)），疑似 30 秒试听片段直接丢弃不入库。匿名导入为 MP3 至多 320k，海外网络对部分曲库有地区差异，如实告知用户，不要承诺导不出的内容。
5. **入库内容**：导入成功自动内嵌网易云元数据（曲名/歌手/专辑/发行日/封面，发行日作为专辑年份）并写 `netease_imports` 溯源；原文与翻译歌词（若有）自动存进曲库歌词，歌词失败只是 `warnings`，不影响音频。文件名 `Netease-<songId>.mp3|flac`，同目录同 ID 已有文件标记 `skipped` 不覆盖。
6. **导入后的曲目管理**：先 `tools.netease.get_metadata_netease({trackId})` 核对曲目、来源 songId 与音质，再动手。改字段用 `tools.netease.edit_metadata_netease({trackId,metadata})`——只传要改的字段，保留 ID 与文件名，不重新下载；`cover` 支持 `"netease"` 恢复来源封面、`*.music.126.net` 链接或 data:image 内联图，仅按用户要求换图；若返回 `warnings` 说明文字只入了曲库未嵌入文件，如实报告。
7. **移出与删除是两件事，都要用户明确要求**：`tools.netease.remove_from_library_netease({trackId})` 只删指定 trackId 的曲库条目，磁盘文件保留；指代或版本不清楚先问用户。`tools.netease.request_file_deletion_netease({trackId})` 只创建 5 分钟人工确认链接，把返回的 Markdown 链接原样交给本人——不要代用户打开、确认，也不要声称文件已删除；确认页需要本人登录并逐字输入文件名，助手没有 confirm 工具，也绝不请求调用任何确认类工具。
