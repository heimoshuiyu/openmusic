import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as fs from "node:fs/promises"
import { Effect } from "effect"
import { BadRequest } from "../../domain/errors"
import { MusicFolderRepo } from "../../repo/music-folders"
import { Scanner } from "../../service/scanner"
import { requireAdmin } from "../middleware/session"

/** SqlError 等基础设施错误 → defect（500），域错误（NotFound 等）保持类型化 */
const infra = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Exclude<E, { readonly _tag: "SqlError" }>, R> =>
  Effect.catch(effect, (error) =>
    (error as { readonly _tag?: string })._tag === "SqlError"
      ? Effect.die(error)
      : Effect.fail(error as never)) as Effect.Effect<A, Exclude<E, { readonly _tag: "SqlError" }>, R>
import { Api } from "./index"
import { ScanStatusResponse } from "./library-schema"

/** 校验音乐文件夹路径：必须是存在的绝对路径目录 */
const validatePath = (path: string): Effect.Effect<string, BadRequest> =>
  Effect.tryPromise({
    try: async () => {
      if (!path.startsWith("/")) throw new Error("path must be absolute")
      const stat = await fs.stat(path)
      if (!stat.isDirectory()) throw new Error("path is not a directory")
      return path
    },
    catch: (cause) => new BadRequest({ message: `invalid music folder path: ${String(cause)}` }),
  })

export const LibraryApiLive = HttpApiBuilder.group(Api, "library", Effect.fn(function* (handlers) {
  const scanner = yield* Scanner
  return handlers.handleAll({
    folders: () => infra(MusicFolderRepo.list),
    createFolder: ({ payload }) => Effect.andThen(requireAdmin,
      Effect.flatMap(
        validatePath(payload.path),
        (path) => infra(MusicFolderRepo.create({ name: payload.name, path })),
      )),
    renameFolder: ({ params, payload }) => Effect.andThen(requireAdmin, infra(MusicFolderRepo.rename(params.id, payload.name))),
    deleteFolder: ({ params }) => Effect.andThen(requireAdmin, infra(MusicFolderRepo.delete(params.id))),
    scan: ({ query }) => Effect.flatMap(requireAdmin, () =>
      Effect.flatMap(Scanner, (scanner) => scanner.start(query?.force ?? false))),
    cancelScan: () => Effect.flatMap(requireAdmin, () => scanner.cancel),
    scanStatus: () =>
      Effect.map(
        Effect.flatMap(Scanner, (scanner) => scanner.status),
        (status) => new ScanStatusResponse({ ...status }),
      ),
  })
}))
