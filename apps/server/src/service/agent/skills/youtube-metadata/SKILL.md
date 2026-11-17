---
name: youtube-metadata
description: 从 YouTube 导入音乐、补专辑艺人流派、核实上传日期，或给刚导入的歌曲更换封面时使用。
---

1. `start_import.format` 省略或 `original` 表示保留源音频编码（Opus / AAC，只在需要时换封装，不转 FLAC）。用户明确说“存 MP3”才传 `mp3`，说“保留画面/下载 MV/存成视频”传 `video`（带声音的 MP4）。提供视频链接本身不代表要求保留画面。以结果 `files` 的实际文件名为准，不同模式不会覆盖。每首用自己的 YouTube 缩略图作内嵌封面，使用 `upload_date`，不是商店发行日。
2. 曲名、艺人已知时，用 `youtube.catalog_search`（日本音乐可选 `JP`）找发行候选。对照官方发行链接、曲名、署名、时长、版本。单曲版/专辑版、现场/录音室、自唱/虚拟歌手版可能同名。频道不等于演唱者，YouTube 类别 `Music` 也不是具体曲风。来源冲突时只补有证据的字段，不把整个候选覆盖上去。
3. 单视频可在 `start_import.metadata` 提交核实的字段。播放列表逐首自动处理，不整批套用同一专辑。报告真实 `trackIds` 和 `warnings`。
4. 改已有导入时先用 `get_metadata` 核对 trackId、版本及原标签，再 `edit_metadata` 只传要改的字段。用户要求其他封面时才传 `cover`（例如目录结果的 Apple 图片 URL）；要恢复视频封面传 `cover:"youtube"`。只有图片、没有受支持的 CDN 链接时，后端也接受有限大小的内联 JPEG/PNG/WebP。不要下载音频第二遍，不做整库扫描。
