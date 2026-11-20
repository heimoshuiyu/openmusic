import * as fs from "node:fs/promises"
import * as nodePath from "node:path"
import { Config, Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { NotFound, Unauthorized } from "../domain/errors"
import { UserPublic } from "../domain/user"
import { MusicFolderRepo } from "../repo/music-folders"
import { UserRepo, type UserRow } from "../repo/users"
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  keyFromHex,
  md5Hex,
  randomToken,
  sha256Hex,
  verifyPassword,
} from "../util/crypto"
import { AppConfig } from "../config"

export const SESSION_COOKIE = "om_session"

/** SqlError 等基础设施错误在服务边界内 die（500）；对外只暴露 Unauthorized */
const infra = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Exclude<E, { readonly _tag: "SqlError" }>, R> =>
  Effect.catch(effect, (error) =>
    (error as { readonly _tag?: string })._tag === "SqlError"
      ? Effect.die(error)
      : Effect.fail(error as never)) as Effect.Effect<A, Exclude<E, { readonly _tag: "SqlError" }>, R>

type Repo = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, Exclude<E, { readonly _tag: "SqlError" }>, Exclude<R, SqlClient.SqlClient>>
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 天滑动过期

export interface AuthApi {
  /** 用户名+密码 → { user, token, expiresAt }；失败 401 */
  readonly login: (
    username: string,
    password: string,
    userAgent: string | null,
  ) => Effect.Effect<{ readonly user: UserPublic; readonly token: string; readonly expiresAt: Date }, Unauthorized>
  readonly logout: (token: string) => Effect.Effect<void>
  /** 会话校验（滑动续期）；失败 401 */
  readonly bySession: (token: string) => Effect.Effect<UserPublic, Unauthorized>
  readonly sessionActive: (token: string, userId: string) => Effect.Effect<boolean>
  /** Subsonic 三模式认证（docs/05 §3）；失败 401 */
  readonly bySubsonicParams: (params: {
    readonly username: string
    readonly token?: string | undefined
    readonly salt?: string | undefined
    readonly password?: string | undefined
  }) => Effect.Effect<UserRow, Unauthorized>
  // ---- 管理操作 ----
  readonly createUser: (input: {
    username: string
    password: string
    isAdmin: boolean
  }) => Effect.Effect<UserPublic>
  /** 用户名是否已被占用 */
  readonly usernameTaken: (username: string) => Effect.Effect<boolean>
  readonly userById: (id: string) => Effect.Effect<UserPublic, NotFound>
  readonly listUsers: (query: { limit: number; offset: number }) => Effect.Effect<
    { items: ReadonlyArray<UserPublic>; total: number; offset: number; limit: number }
  >
  readonly setPassword: (id: string, password: string) => Effect.Effect<void, NotFound>
  readonly setRole: (id: string, isAdmin: boolean) => Effect.Effect<void, NotFound>
  readonly deleteUser: (id: string) => Effect.Effect<void, NotFound>
}

const byRow = (row: UserRow): UserPublic =>
  new UserPublic({
    id: String(row.id),
    username: row.username,
    isAdmin: row.is_admin,
    createdAt: new Date(row.created_at).toISOString(),
    lastSeenAt: row.last_seen_at === null ? null : new Date(row.last_seen_at).toISOString(),
  })

export class Auth extends Context.Service<Auth, AuthApi>()("app/Auth") {
  static readonly layer = Layer.effect(
    Auth,
    Effect.gen(function* () {
    const config = yield* AppConfig
    const sql = yield* SqlClient.SqlClient
    // repo 调用统一：注入捕获的 SqlClient（消除 R）+ SqlError die
    const repo: Repo = (effect) => infra(Effect.provideService(effect, SqlClient.SqlClient, sql))

    // ---- Subsonic 凭据密钥（OPENMUSIC_SECRET 或首启生成 DATA_DIR/secret.key） ----
    const secretKey: Uint8Array = yield* Effect.promise(async () => {
      const fromEnv = process.env.OPENMUSIC_SECRET
      if (fromEnv !== undefined && fromEnv.length >= 16) {
        return keyFromHex(sha256Hex(fromEnv))
      }
      const keyPath = `${config.dataDir}/secret.key`
      try {
        return keyFromHex((await fs.readFile(keyPath, "utf8")).trim())
      } catch (e) {
        // 只有「文件不存在」才走首启生成；权限/IO 故障宁可启动失败——
        // 静默换新 key 会让全部存量 Subsonic 凭据不可解密，且只表现为每个客户端 40，无从排查
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error(
            `无法读取 ${keyPath}（${(e as NodeJS.ErrnoException).code}）：拒绝重建密钥。修复挂载/权限后重启；如确认放弃存量凭据，删除该文件再重启将重新生成`,
            { cause: e },
          )
        }
        await fs.mkdir(config.dataDir, { recursive: true })
        const generated = randomToken(32)
        await fs.writeFile(keyPath, `${generated}\n`, { mode: 0o600 })
        return keyFromHex(generated)
      }
    })

    /** 密码明文解密后做 Subsonic 式校验 */
    const verifyTokenMode = (stored: string, token: string, salt: string) =>
      Effect.map(decryptSecret(secretKey, stored), (password) =>
        md5Hex(password + salt) === token.toLowerCase())

    const verifyPlainMode = (stored: string, plain: string) =>
      // seed 存 hex(md5(pw))：明文模式先哈希再比对（docs/05 §3）
      Effect.map(decryptSecret(secretKey, stored), (seed) => seed === md5Hex(plain))

    const verifyHexMode = (stored: string, hex: string) =>
      // seed 存 hex(md5(pw))：enc:hex 直接比对（docs/05 §3）
      Effect.map(decryptSecret(secretKey, stored), (seed) => seed === hex.toLowerCase())

    // ---- 首启管理员引导（users 表为空时执行一次） ----
    yield* Effect.gen(function* () {
      const count = yield* repo(UserRepo.count)
      if (count > 0) return
      const username = yield* Config.withDefault(Config.String("OPENMUSIC_ADMIN_USER"), "admin")
      const envPassword = process.env.OPENMUSIC_ADMIN_PASSWORD
      const passwordFromEnv = envPassword !== undefined && envPassword.length >= 6
      const password = passwordFromEnv ? envPassword : randomToken(6)
      const hash = yield* hashPassword(password)
      const secret = yield* encryptSecret(secretKey, md5Hex(password)) // seed=hex(md5(pw))，docs/03 §2.7
      yield* repo(UserRepo.create({ username, passwordHash: hash, secret, isAdmin: true }))
      if (envPassword !== undefined && !passwordFromEnv) {
        yield* Effect.logWarning("OPENMUSIC_ADMIN_PASSWORD 少于 6 位，已忽略并改用随机密码（见下一条日志，仅打印一次）")
      }
      if (!passwordFromEnv) {
        yield* Effect.logWarning(
          `bootstrap admin created — username: ${username} password: ${password} (仅打印一次，请立即保存)`,
        )
      } else {
        yield* Effect.logInfo(`bootstrap admin created — username: ${username}`)
      }
    }).pipe(Effect.catchCause((cause) => Effect.logError("admin bootstrap failed", cause)))

    // ---- 首启音乐目录种子（MUSIC_FOLDERS，music_folders 为空时执行一次；docs/02 §7） ----
    yield* Effect.gen(function* () {
      if (config.musicFoldersSeed.length === 0) return
      const existing = yield* repo(MusicFolderRepo.list)
      if (existing.length > 0) return
      for (const raw of config.musicFoldersSeed.split(",")) {
        const folderPath = raw.trim()
        if (folderPath.length === 0) continue
        if (!nodePath.isAbsolute(folderPath)) {
          yield* Effect.logWarning(`MUSIC_FOLDERS: skipping non-absolute path ${folderPath}`)
          continue
        }
        const name = folderPath.split("/").filter(Boolean).pop() ?? folderPath
        yield* repo(MusicFolderRepo.create({ name, path: folderPath }))
        yield* Effect.logInfo(`bootstrap music folder seeded — ${folderPath}`)
      }
    }).pipe(Effect.catchCause((cause) => Effect.logError("music folder seed failed", cause)))

    const login = (username: string, password: string, userAgent: string | null) =>
      Effect.flatMap(repo(UserRepo.findByUsername(username)), (row) =>
        Option.match(row, {
          onNone: () => Effect.fail(new Unauthorized({ message: "invalid credentials" })),
          onSome: (row) =>
            Effect.flatMap(verifyPassword(password, row.password_hash), (ok) => {
              if (!ok) {
                return Effect.fail(new Unauthorized({ message: "invalid credentials" }))
              }
              const token = randomToken(32)
              const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
              return Effect.as(
                repo(UserRepo.createSession({ token, userId: Number(row.id), expiresAt, userAgent })),
                { user: byRow(row), token, expiresAt },
              )
            }),
        }))

    const logout = (token: string) => repo(UserRepo.deleteSession(token))

    const bySession = (token: string) =>
      Effect.flatMap(repo(UserRepo.findSession(token)), (session) =>
        Option.match(session, {
          onNone: () => Effect.fail(new Unauthorized({ message: "session not found" })),
          onSome: ({ user, expiresAt }) => {
            if (expiresAt.getTime() < Date.now()) {
              return Effect.flatMap(
                repo(UserRepo.deleteSession(token)),
                () => Effect.fail(new Unauthorized({ message: "session expired" })),
              )
            }
            const nextExpiry = new Date(Date.now() + SESSION_TTL_MS)
            return Effect.as(
              Effect.flatMap(repo(UserRepo.extendSession(token, nextExpiry)), () =>
                repo(UserRepo.touchLastSeen(Number(user.id)))),
              byRow(user),
            )
          },
        }))

    const bySubsonicParams = (
      params: {
        readonly username: string
        readonly token?: string | undefined
        readonly salt?: string | undefined
        readonly password?: string | undefined
      },
    ) =>
      Effect.flatMap(repo(UserRepo.findByUsername(params.username)), (row) =>
        Option.match(row, {
          onNone: () =>
            Effect.fail(new Unauthorized({ message: "wrong username or password" })),
          onSome: (row) => {
            const verified: Effect.Effect<boolean> =
              params.token !== undefined && params.salt !== undefined
                ? verifyTokenMode(row.subsonic_token_seed, params.token, params.salt)
                : params.password !== undefined
                  ? params.password.startsWith("enc:")
                    ? verifyHexMode(row.subsonic_token_seed, params.password.slice(4))
                    : verifyPlainMode(row.subsonic_token_seed, params.password)
                  : Effect.succeed(false)
            return Effect.flatMap(verified, (ok) =>
              ok
                ? Effect.succeed(row)
                : Effect.fail(new Unauthorized({ message: "wrong username or password" })))
          },
        }))

    const createUser = (input: { username: string; password: string; isAdmin: boolean }) =>
      Effect.flatMap(repo(UserRepo.findByUsername(input.username)), (existing) =>
        Option.isSome(existing)
          ? Effect.die(new Error(`username taken: ${input.username}`)) // 由 handler 层先查重，此处兜底
          : Effect.flatMap(hashPassword(input.password), (hash) =>
            Effect.flatMap(encryptSecret(secretKey, md5Hex(input.password)), (secret) =>
              repo(UserRepo.create({
                username: input.username,
                passwordHash: hash,
                secret,
                isAdmin: input.isAdmin,
              })))))

    return {
      login,
      logout,
      bySession,
      sessionActive: (token, userId) => repo(UserRepo.sessionActive(token, userId)),
      bySubsonicParams,
      createUser,
      usernameTaken: (username: string) => Effect.map(repo(UserRepo.findByUsername(username)), Option.isSome),
      userById: (id: string) => repo(UserRepo.byId(id)),
      listUsers: (query: { limit: number; offset: number }) => repo(UserRepo.list(query)),
      setPassword: (id: string, password: string) =>
        Effect.flatMap(hashPassword(password), (hash) =>
          Effect.flatMap(encryptSecret(secretKey, md5Hex(password)), (secret) =>
            repo(UserRepo.setPassword(id, hash, secret)))),
      setRole: (id: string, isAdmin: boolean) => repo(UserRepo.setRole(id, isAdmin)),
      deleteUser: (id: string) => repo(UserRepo.delete(id)),
    }
    }),
  )
}
