import { PgMigrator } from "@effect/sql-pg"
import type { Loader as MigrationLoader } from "effect/unstable/sql/Migrator"
import { BunFileSystem, BunPath, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"

const MIGRATIONS_DIR = `${import.meta.dir}/migrations`

/**
 * 把 .sql 迁移文件按语句切开（导出供单测）。
 * 约定：迁移文件中不得出现包含 ";" 的字符串字面量或函数体（0001 起全部为简单 DDL）。
 */
export const splitStatements = (text: string): ReadonlyArray<string> =>
  text
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.replace(/^--.*$/gm, "").trim().length > 0)

/** 用 Bun.Glob 扫描 migrations/*.sql，文件名必须为 NN-name.sql */
const loadMigrations: MigrationLoader = Effect.map(
  Effect.promise(async () => {
    const glob = new Bun.Glob("*.sql")
    const files = Array.from(glob.scanSync({ cwd: MIGRATIONS_DIR })).sort()
    return files.map((file) => {
      const id = Number.parseInt(file.split("-")[0]!, 10)
      if (Number.isNaN(id)) {
        throw new Error(`migration file must be NN-name.sql: ${file}`)
      }
      const name = file.replace(/\.sql$/, "")
      const path = `${MIGRATIONS_DIR}/${file}`
      // Migrator 约定：load 解析出的值必须是一个 Effect（迁移本体，在事务中执行）
      const load = Effect.succeed(
        Effect.flatMap(
          Effect.promise(() => Bun.file(path).text()),
          (text) =>
            Effect.flatMap(
              SqlClient.SqlClient,
              (sql) =>
                Effect.forEach(splitStatements(text), (statement) => sql.unsafe(statement), {
                  discard: true,
                }),
            ),
        ),
      )
      return [id, name, load] as const
    })
  }),
  (migrations) => migrations,
)

/**
 * 启动时自动执行迁移（构造期失败即拒绝启动）。
 * v4 的 PgMigrator 需要 FileSystem / Path / ChildProcessSpawner（pg_dump 支持用），
 * 由 platform-bun 的实现层满足。
 */
export const MigratorLive = PgMigrator.layer({ loader: loadMigrations }).pipe(
  Layer.provide(BunServices.layer),
  Layer.provide(BunFileSystem.layer),
  Layer.provide(BunPath.layer),
)
