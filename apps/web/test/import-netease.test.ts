import { expect, test } from "bun:test"
import { ApiError, type NeteaseImportResult, type NeteaseInfo } from "../src/api/client"
import {
  neteaseFormTags, neteaseLink, neteaseOutcome, neteaseTagsDiff, partitionTracks, resolveDeletionReview, subdirectoryProblem,
} from "../src/imports/view-model"

test("客户端镜像服务端白名单：规范化重建网易云链接，绝不透传原始输入", () => {
  for (const [raw, expected] of [
    ["https://music.163.com/song?id=5264842", { kind: "song", id: "5264842" }],
    ["http://music.163.com/song?id=5264842&userid=1", { kind: "song", id: "5264842" }],
    ["https://music.163.com/#/song?id=5264842", { kind: "song", id: "5264842" }],
    ["https://y.music.163.com/m/song?id=5264842", { kind: "song", id: "5264842" }],
    ["https://music.163.com/m/song/5264842", { kind: "song", id: "5264842" }],
    ["https://www.music.163.com/song/?id=5264842", { kind: "song", id: "5264842" }],
    ["https://music.163.com/playlist?id=718606", { kind: "playlist", id: "718606" }],
    ["https://music.163.com/#/playlist?id=718606", { kind: "playlist", id: "718606" }],
    ["https://music.163.com/album?id=35135711", { kind: "album", id: "35135711" }],
    ["https://music.163.com/#/album?id=35135711", { kind: "album", id: "35135711" }],
    ["https://y.music.163.com/m/album?id=35135711", { kind: "album", id: "35135711" }],
    ["https://music.163.com/artist?id=6454", { kind: "artist", id: "6454" }],
    [" https://music.163.com/song?id=6454 ", { kind: "song", id: "6454" }],
  ] as const) {
    expect(neteaseLink(raw)).toEqual({ ...expected, url: `https://music.163.com/${expected.kind}?id=${expected.id}` })
  }
})

test("客户端镜像服务端拒绝面：其他 host、路径、ID 与注入尝试一律不可导入", () => {
  for (const url of [
    "", "   ", "放点歌", "file:///etc/passwd", "--exec=echo", "netease:song:5264842",
    "https://music.163.com.evil.com/song?id=5264842",
    "https://evil.com/?u=https://music.163.com/song?id=5264842",
    "https://user@music.163.com/song?id=5264842",
    "http://music.163.com:555/song?id=5264842",
    "https://music.163.com/discover/playlist?id=5264842",
    "https://music.163.com/dj?id=5264842",
    "https://music.163.com/song?id=abc", "https://music.163.com/song?id=",
    "https://music.163.com/song?id=123456789012345678901",
    "https://v6.music.163.com/song?id=5264842",
    "https://music.163.com/song/5264842/extra",
    "https://music.163.com/#/mv?id=5264842",
    "https://music.163.com/",
    "https://music.163.com/song?id=5264842".repeat(120),
  ]) expect(neteaseLink(url)).toBeNull()
})

test("子目录校验镜像 checkSubdirectory：空可用，非法段与越界给出中文提示", () => {
  expect(subdirectoryProblem("")).toBeNull()
  expect(subdirectoryProblem("网易云/周杰伦")).toBeNull()
  expect(subdirectoryProblem("a/b/c/d/e/f/g/h")).toBeNull()
  expect(subdirectoryProblem(".hidden")).toContain("点开头")
  expect(subdirectoryProblem("a//b")).toContain("空段")
  expect(subdirectoryProblem(Array.from({ length: 9 }, () => "a").join("/"))).toContain("8 层")
  expect(subdirectoryProblem(`${"a".repeat(101)}`)).toContain("100 字符")
  expect(subdirectoryProblem("a\\b")).toContain("反斜杠")
  expect(subdirectoryProblem("a:b")).toContain("冒号")
  expect(subdirectoryProblem(`${"a".repeat(361)}`)).toContain("360 字符")
})

test("neteaseOutcome 归一化：songId 维映射到结果面板的 id 维，计数与终态透传", () => {
  const result: NeteaseImportResult = {
    url: "https://music.163.com/song?id=5264842", kind: "playlist", state: "partial",
    total: 3, imported: 1, skipped: 1, failed: 1, destination: "/music/网易云",
    trackIds: [42, 43],
    files: [{ trackId: 42, name: "Netease-5264842.mp3" }],
    failures: [{ songId: "2606227455", reason: "VIP/付费歌曲需要会员账号，未导入。" }],
    warnings: [{ songId: "5264842", message: "未取得歌词。" }],
  }
  const outcome = neteaseOutcome(result)
  expect(outcome.kind).toBe("歌单")
  expect(outcome.state).toBe("partial")
  expect(outcome.trackIds).toEqual([42, 43])
  expect(outcome.failures).toEqual([{ id: "2606227455", reason: "VIP/付费歌曲需要会员账号，未导入。" }])
  expect(outcome.warnings).toEqual([{ id: "5264842", message: "未取得歌词。" }])
})

const info: NeteaseInfo = {
  trackId: "42", songId: "5264842", quality: "320k", format: "mp3", filename: "Netease-5264842.mp3",
  title: "晴天", artist: "周杰伦", album: "叶惠美", albumArtist: "周杰伦", genre: "Pop",
  trackNumber: 3, discNumber: 1, hasCover: true,
}

test("表单原始字符串 → tags：清空碟号等于不改（绝不发送 Number(\"\")=0），越界同样省略", () => {
  // 只清空碟号，其余与当前一致：无任何字段被提交
  expect(neteaseFormTags(info, {
    title: "晴天", artist: "周杰伦", album: "叶惠美", albumArtist: "周杰伦", genre: "Pop",
    trackNumber: "3", discNumber: "", cover: "",
  })).toEqual({})
  // 越界/垃圾位置输入一律省略，不把 0 或 10000 发给服务端
  expect(neteaseFormTags(info, {
    title: "晴天（Live版）", artist: "周杰伦", album: "叶惠美", albumArtist: "周杰伦", genre: "Pop",
    trackNumber: "0", discNumber: "10000", cover: "",
  })).toEqual({ title: "晴天（Live版）" })
  // 合法改动的位置字段照常提交
  expect(neteaseFormTags(info, {
    title: "晴天", artist: "周杰伦", album: "叶惠美", albumArtist: "周杰伦", genre: "Pop",
    trackNumber: " 5 ", discNumber: "2", cover: "netease",
  })).toEqual({ trackNumber: 5, discNumber: 2, cover: "netease" })
})

test("allSettled 分区：一首失败不拖垮其余，全部失败才无法播放", async () => {
  const settled = await Promise.allSettled([Promise.resolve(1), Promise.reject(new Error("a")), Promise.resolve(3), Promise.reject(new Error("b"))])
  expect(partitionTracks(settled)).toEqual({ tracks: [1, 3], failed: 2 })
  const allOk = await Promise.allSettled([Promise.resolve(1), Promise.resolve(2)])
  expect(partitionTracks(allOk)).toEqual({ tracks: [1, 2], failed: 0 })
  const allBad = await Promise.allSettled([Promise.reject(new Error("x"))])
  expect(partitionTracks(allBad)).toEqual({ tracks: [], failed: 1 })
  expect(partitionTracks([])).toEqual({ tracks: [], failed: 0 })
})

test("neteaseTagsDiff:元数据编辑 diff：只提交改动且非空的字段", () => {
  expect(neteaseTagsDiff(info, {
    title: "晴天", artist: "周杰伦", album: "叶惠美", albumArtist: "周杰伦", genre: "Pop",
    trackNumber: 3, discNumber: 1, cover: "",
  })).toEqual({})
  expect(neteaseTagsDiff(info, {
    title: " 晴天（Live版） ", artist: " 周杰伦 ", album: "叶惠美", albumArtist: "周杰伦", genre: "Pop",
    trackNumber: null, discNumber: 2, cover: "netease",
  })).toEqual({ title: "晴天（Live版）", discNumber: 2, cover: "netease" })
  // 与当前值相同的位置字段与空白文本字段都不发送；服务端仍是权威校验
  expect(neteaseTagsDiff(info, {
    title: "", artist: "", album: "", albumArtist: "", genre: "Pop",
    trackNumber: 3, discNumber: 1, cover: "  ",
  })).toEqual({})
})

test("删除票据解析：YouTube 命中即用；只有明确 404 才回落网易云，其余错误如实上抛", async () => {
  // YouTube 直接命中：绝不触碰网易云端点
  let neteaseCalled = 0
  const resolved = await resolveDeletionReview(
    "k", async () => "youtube-review",
    async () => { neteaseCalled++; throw new Error("should not be called") },
  )
  expect("review" in resolved && resolved.source).toBe("youtube")
  expect("review" in resolved && resolved.review).toBe("youtube-review")
  expect(neteaseCalled).toBe(0)

  // YouTube 404 → 网易云命中
  const fellBack = await resolveDeletionReview(
    "k", async () => { throw new ApiError(404, "not found") }, async () => "netease-review",
  )
  expect("review" in fellBack && fellBack.source).toBe("netease")
  expect("review" in fellBack && fellBack.review).toBe("netease-review")

  // 双 404 → 申请不存在的友好文案
  const missing = await resolveDeletionReview(
    "k", async () => { throw new ApiError(404, "not found") }, async () => { throw new ApiError(404, "not found") },
  )
  expect("missing" in missing && missing.message).toBe("申请不存在、已过期，或不属于当前账号。")

  // 其他错误（网络/500/非 ApiError）不得盲目回落
  const other = await resolveDeletionReview(
    "k", async () => { throw new ApiError(503, "服务暂不可用") }, async () => { throw new Error("不应被调用") },
  )
  expect("missing" in other && other.message).toBe("服务暂不可用")
  const crashed = await resolveDeletionReview(
    "k", async () => { throw new Error("fetch failed") }, async () => { throw new Error("不应被调用") },
  )
  expect("missing" in crashed && crashed.message).toBe("fetch failed")
  // 回落过程中网易云报非 404 也如实上抛
  const neteaseBroken = await resolveDeletionReview(
    "k", async () => { throw new ApiError(404, "not found") }, async () => { throw new ApiError(500, "boom") },
  )
  expect("missing" in neteaseBroken && neteaseBroken.message).toBe("boom")
})
