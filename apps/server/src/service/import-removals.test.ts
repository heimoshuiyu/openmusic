import { expect, test } from "bun:test"
import { ticketBook, type TicketedTarget } from "./import-removals"

/** 纯票据簿（service/import-removals.ts 导出的可测接缝）：无 DB、无文件系统、无时钟依赖。 */

const target = (id: string): TicketedTarget => ({ id, name: `Netease-${id}.mp3` })

test("票据按属主隔离：他人找不到，属主可读 token", () => {
  const book = ticketBook<TicketedTarget>()
  const entry = book.put(1, target("42"), "fp", "token-1")
  if (entry === false) throw Error("put 不应失败")
  expect(book.find(1, entry.key)?.token).toBe("token-1")
  expect(book.find(2, entry.key)).toBeUndefined()
  expect(book.find(1, "missing-key")).toBeUndefined()
})

test("惰性过期：5 分钟窗口用尽后票据不可见", () => {
  let now = 1_000_000
  const book = ticketBook<TicketedTarget>(() => now)
  const entry = book.put(1, target("42"), "fp", "token")
  if (entry === false) throw Error("put 不应失败")
  expect(entry.expires).toBe(now + 5 * 60_000)
  now += 5 * 60_000 - 1
  expect(book.find(1, entry.key)?.token).toBe("token")
  now += 1
  expect(book.find(1, entry.key)).toBeUndefined()
})

test("同一 (属主,目标) 只保留最新一张票；其他目标不受影响", () => {
  const book = ticketBook<TicketedTarget>()
  const first = book.put(1, target("42"), "fp", "t1")
  const second = book.put(1, target("42"), "fp2", "t2")
  if (first === false || second === false) throw Error("put 不应失败")
  expect(book.find(1, first.key)).toBeUndefined()
  expect(book.find(1, second.key)?.identity).toBe("fp2")
  const other = book.put(1, target("43"), "fp3", "t3")
  if (other === false) throw Error("put 不应失败")
  expect(book.find(1, other.key)?.token).toBe("t3")
  // 换票只看属主+目标：不同属主的同目标票据共存
  const bob = book.put(2, target("42"), "fp4", "t4")
  if (bob === false) throw Error("put 不应失败")
  expect(book.find(2, bob.key)?.token).toBe("t4")
  expect(book.find(1, second.key)?.token).toBe("t2")
})

test("全局 256 张上限：满了拒绝；drop 后可再入", () => {
  const book = ticketBook<TicketedTarget>()
  let firstKey = ""
  for (let n = 0; n < 256; n++) {
    const entry = book.put(1, target(String(n)), "fp", "t")
    if (entry === false) throw Error(`第 ${n} 张不应被拒`)
    if (n === 0) firstKey = entry.key
  }
  expect(book.put(1, target("999"), "fp", "t")).toBe(false)
  book.drop(firstKey)
  const again = book.put(1, target("999"), "fp", "t")
  if (again === false) throw Error("drop 后应可再入")
  expect(book.find(1, again.key)?.token).toBe("t")
})
