/**
 * MUSIC_FOLDERS 首启种子集成测试：进程内 web handler + 真实 Postgres（openmusic_test 库）。
 * 前置与运行方式见 integration.test.ts 头注。
 */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { TestServer, migrateTestDb, startServer, truncateDomainTables } from "./helpers"

const SEED_A = "/tmp/om-seed-alpha"
const SEED_B = "/tmp/om-seed-beta"

let server: TestServer
let dispose: () => Promise<void>

beforeAll(async () => {
  // 必须在 startServer() 之前设置：helpers 的 TestAppConfig 在 startServer 内读取该变量
  process.env.MUSIC_FOLDERS = `${SEED_A},${SEED_B},relative/path`
  await migrateTestDb()
  await truncateDomainTables(true)
  const started = await startServer()
  server = new TestServer(started.handler)
  dispose = started.dispose
  // toWebHandler 惰性构建：预热触发首启引导（管理员 + MUSIC_FOLDERS 种子）
  const warmup = await server.get("/api/v1/system/health")
  expect(warmup.status).toBe(200)
  await server.login()
})

afterAll(async () => {
  delete process.env.MUSIC_FOLDERS
  await dispose()
})

test("MUSIC_FOLDERS 首启把绝对路径注册为音乐目录，忽略相对路径", async () => {
  const res = await server.get("/api/v1/music-folders")
  expect(res.status).toBe(200)
  const folders = res.body as ReadonlyArray<{ id: string; name: string; path: string }>
  expect(folders.map((f) => f.path).sort()).toEqual([SEED_A, SEED_B])
  expect(folders.find((f) => f.path === SEED_A)?.name).toBe("om-seed-alpha")
  expect(folders.find((f) => f.path === SEED_B)?.name).toBe("om-seed-beta")
})
