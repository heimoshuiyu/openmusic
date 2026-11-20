import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { NeteaseInfo, NeteaseTags } from "../src/api/client"
import { ImportResultPanel } from "../src/imports/import-result"
import { NeteaseEditForm, NeteaseInfoBody } from "../src/imports/import-manage"
import type { ImportOutcome } from "../src/imports/view-model"

const outcome = (overrides: Partial<ImportOutcome> = {}): ImportOutcome => ({
  kind: "单曲", state: "done", total: 1, imported: 1, skipped: 0, failed: 0,
  destination: "/music/网易云", trackIds: [42],
  files: [{ trackId: 42, name: "Netease-5264842.mp3" }],
  failures: [], warnings: [],
  ...overrides,
})

const ManageStub = ({ trackId, label }: { trackId: string; label: string }) =>
  <span data-manage={`${trackId}:${label}`} />

test("导入结果面板：终态、计数、文件与管理插槽；失败红显、提示灰显", () => {
  const done = renderToStaticMarkup(<ImportResultPanel
    outcome={outcome()} manage={ManageStub}
    onPlay={() => {}} onEnqueue={() => {}} onDismiss={() => {}}
  />)
  expect(done).toContain("完成")
  expect(done).toContain("共 1 · 导入 1 · 跳过 0 · 失败 0")
  expect(done).toContain("/music/网易云")
  expect(done).toContain("Netease-5264842.mp3")
  expect(done).toContain('data-manage="42:Netease-5264842.mp3"')
  expect(done).toContain("立即播放")
  expect(done).toContain("加入队列")

  const failed = renderToStaticMarkup(<ImportResultPanel outcome={outcome({
    state: "failed", imported: 0, trackIds: [],
    failures: [{ id: "2606227455", reason: "VIP/付费歌曲需要会员账号，未导入。" }],
    warnings: [{ id: "5264842", message: "未取得歌词。" }],
  })} />)
  expect(failed).toContain("失败")
  expect(failed).toContain("未导入（1）")
  expect(failed).toContain("VIP/付费歌曲需要会员账号，未导入。")
  expect(failed).toContain("提示（1）")
  expect(failed).toContain("未取得歌词。")
  // 全部失败时没有可播放曲目：播放/入队按钮不出现
  expect(failed).not.toContain("立即播放")
  expect(failed).not.toContain("加入队列")

  const partial = renderToStaticMarkup(<ImportResultPanel
    outcome={outcome({ state: "partial", failed: 1 })}
    onPlay={() => {}} onEnqueue={() => {}} busy
  />)
  expect(partial).toContain("部分成功")
  // busy 态按钮置灰，防重复解析曲目
  expect(partial).toContain("disabled")
})

const info: NeteaseInfo = {
  trackId: "42", songId: "5264842", quality: "320k", format: "mp3", filename: "Netease-5264842.mp3",
  title: "晴天", artist: "周杰伦", album: "叶惠美", albumArtist: "周杰伦", genre: "Pop",
  trackNumber: 3, discNumber: 1, hasCover: true,
}

test("管理菜单正文：元数据读数、warnings 与三个动作；404 文案在外层容器", () => {
  const html = renderToStaticMarkup(<NeteaseInfoBody
    info={{ ...info, warnings: ["仅更新了曲库，未改写文件标签。"] }}
    onEdit={() => {}}
    onUnindex={() => {}}
    onRequestDeletion={() => {}}
  />)
  expect(html).toContain("晴天")
  expect(html).toContain("5264842")
  expect(html).toContain("320k · MP3")
  expect(html).toContain("Netease-5264842.mp3")
  expect(html).toContain("仅更新了曲库，未改写文件标签。")
  expect(html).toContain("编辑元数据")
  expect(html).toContain("移出曲库（保留文件）")
  expect(html).toContain("申请永久删除原文件")
  // 三个动作都给出，但都没有直接执行删除：永久删除只能走人工核对页
  const noActions = renderToStaticMarkup(<NeteaseInfoBody info={info} />)
  expect(noActions).not.toContain("申请永久删除原文件")
})

test("编辑表单按当前值预填，封面留空不修改", () => {
  const submitted: NeteaseTags[] = []
  const html = renderToStaticMarkup(<NeteaseEditForm info={info} onSubmit={(tags) => submitted.push(tags)} />)
  for (const value of ["晴天", "周杰伦", "叶惠美", "Pop", "3", "1"]) expect(html).toContain(`value="${value}"`)
  expect(html).toContain("留空不修改")
  expect(html).toContain("只提交改过的字段")
})

test("VIP 候选行与管理插槽在同一结果页共存：文件行都能挂管理入口", () => {
  const list = renderToStaticMarkup(<ImportResultPanel
    outcome={outcome({
      kind: "歌单", state: "partial", total: 2, imported: 1, failed: 1,
      trackIds: [42],
      files: [{ trackId: 42, name: "Netease-5264842.mp3" }, { trackId: 43, name: "Netease-2606227455.mp3" }],
      failures: [{ id: "2606227455", reason: "VIP/付费歌曲需要会员账号，未导入。" }],
    })}
    manage={ManageStub}
  />)
  expect(list).toContain('data-manage="42:Netease-5264842.mp3"')
  expect(list).toContain('data-manage="43:Netease-2606227455.mp3"')
  expect(list).toContain("歌单")
})
