import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import * as fs from "node:fs"
import * as path from "node:path"
import { Effect } from "effect"

const DIST = path.resolve(import.meta.dir, "../../../web/dist") // apps/web/dist（构建产物）

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
}

/**
 * 生产模式静态文件服务：serve apps/web/dist（SPA，未知路径回退 index.html）。
 * dist 不存在时（dev 模式）不挂载任何路由，前端走 Vite :5175。
 */
export const StaticRoutesLive = HttpRouter.use((router) =>
  Effect.gen(function* () {
    if (!fs.existsSync(DIST)) {
      return
    }
    const serve = Effect.gen(function* () {
        const route = yield* HttpRouter.RouteContext
        const clean = route.params["*"] ?? ""
        const resolved = path.normalize(path.join(DIST, clean))
        const file =
          resolved.startsWith(DIST) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()
            ? resolved
            : path.join(DIST, "index.html")
        const mime = MIME[path.extname(file)] ?? "application/octet-stream"
        return yield* HttpServerResponse.file(file, {
          contentType: mime,
          headers: file.endsWith("index.html")
            ? { "cache-control": "no-cache" }
            : { "cache-control": "public, max-age=86400" },
        })
      },
    ).pipe(Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 404 }))))

    yield* router.add("GET", "*", serve)
  }))
