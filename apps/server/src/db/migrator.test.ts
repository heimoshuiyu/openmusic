import { describe, expect, test } from "bun:test"
import { splitStatements } from "./migrator"

describe("迁移文件语句切割", () => {
  test("多语句按分号+换行切开", () => {
    const statements = splitStatements(`
      create table a (id int);
      create table b (id int);
      create index on a (id);
    `)
    expect(statements).toEqual([
      "create table a (id int)",
      "create table b (id int)",
      "create index on a (id)",
    ])
  })

  test("分号后有注释时不切割（整块保留，仍为单语句）", () => {
    const statements = splitStatements(`
      -- comment only line
      create table a (id int); -- trailing comment
      -- another
    `)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain("create table a (id int)")
    // 注释块独立成块时被过滤为空语句
    expect(splitStatements("-- only comment;\n")).toEqual([])
  })

  test("全部为注释/空白 → 空数组", () => {
    expect(splitStatements("-- nothing here\n\n-- more\n")).toEqual([])
    expect(splitStatements("")).toEqual([])
    expect(splitStatements("\n\n")).toEqual([])
  })

  test("行内双语句（分号后同行继续）按约定不切", () => {
    // 约定：按 ";\s*\n" 切割 —— 同一行上的两个语句不会被分开（迁移文件不这么写）
    const statements = splitStatements("create table a (id int); create table b (id int);\n")
    expect(statements).toEqual(["create table a (id int); create table b (id int)"])
  })

  test("0001 迁移文件自身可被切割且无空块", async () => {
    const text = await Bun.file(`${import.meta.dir}/migrations/0001-init.sql`).text()
    const statements = splitStatements(text)
    expect(statements.length).toBeGreaterThan(20)
    for (const statement of statements) {
      expect(statement.length).toBeGreaterThan(0)
      expect(statement.replace(/^--.*$/gm, "").trim().length).toBeGreaterThan(0)
    }
  })
})
