import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AssistantMarkdown } from "../src/agent/assistant-markdown"

const render = (text: string, streaming = false) => renderToStaticMarkup(<AssistantMarkdown text={text} streaming={streaming} />)

test("saved listening reports render CJK emphasis, lists, tables and literal code", () => {
  const html = render('## 总量\n\n30 天内**播放 1,408 次**。\n\n- 第一首\n- 第二首\n\n| 特征 | 表现 |\n|---|---|\n| 循环 | 8 次 |\n\n```md\n## 代码不是标题\n```')
  for (const snippet of ["<h2>总量</h2>", "<strong>播放 1,408 次</strong>", "<li>第一首</li>", "<th>特征</th>", "<td>8 次</td>", "<pre><code>## 代码不是标题"]) expect(html).toContain(snippet)
  expect(html).not.toContain("data-sd-animate")
})

test("incomplete emphasis is repaired only for the live projection", () => {
  expect(render("**试听", true)).toContain("<strong")
  expect(render("**试听", true)).toContain("data-sd-animate")
  expect(render("**试听")).toContain("**试听")
})

test("assistant markup cannot inject HTML, load remote images or navigate unsafe URLs", () => {
  const html = render('<img src="/bad" onerror="boom()">\n\n![封面](https://example.com/cover) [bad](javascript:boom) [文档](https://example.com/)')
  expect(html).not.toContain("<img")
  expect(html).not.toContain('href="javascript:')
  expect(html).toContain('href="https://example.com/"')
  expect(html).toContain("封面")
})

test("only a scoped same-origin deletion review URL is actionable, not arbitrary relative API links",()=>{
  const review="/review-deletion/38b16b92-59b5-48dd-b26f-1dff485dc397"
  const html=render(`[核对文件](${review}) [bad](/api/v1/private) [other](//attacker.example)`)
  expect(html).toContain(`href="${review}"`);expect(html).not.toContain('href="/api/');expect(html).not.toContain('href="//')
})
