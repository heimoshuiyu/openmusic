import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Effect } from "effect"
import {
  SUBSONIC_ERRORS,
  envelope,
  node,
  subsonicResponse,
  type SChild,
} from "../../domain/subsonic"
import { SqlClient } from "effect/unstable/sql"
import { Auth } from "../../service/auth"
import { Scanner } from "../../service/scanner"
import { Stream } from "../../service/stream"
import { AnnotationRepo, PlayRepo } from "../../repo/annotations"
import { PlaylistRepo } from "../../repo/playlists"
import { SubsonicRepo, infra, type Row } from "../../repo/subsonic"
import {
  albumNode,
  artistListEntryNode,
  artistNode,
  dirId,
  groupByIndex,
  parseDirId,
  songNode,
} from "./mappers"

type Params = Readonly<Record<string, string | ReadonlyArray<string> | undefined>>

const first = (params: Params, key: string): string | undefined => {
  const value = params[key]
  if (value === undefined) return undefined
  return typeof value === "string" ? value : value[0]
}

const many = (params: Params, key: string): ReadonlyArray<string> => {
  const value = params[key]
  if (value === undefined) return []
  return typeof value === "string" ? [value] : value
}

const int = (params: Params, key: string): number | undefined => {
  const raw = first(params, key)
  if (raw === undefined || raw === "") return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isNaN(parsed) ? undefined : parsed
}

const rowsOf = (rows: unknown): ReadonlyArray<Row> => rows as ReadonlyArray<Row>
const rowOf = (rows: unknown): Row | undefined => rowsOf(rows)[0]

/**
 * Subsonic 兼容层（/rest/*，Feishin 实测行为见 docs/05）。
 * 统一分发器：GET/POST /rest/<endpoint>[.view]，query 参数驱动。
 */
export const SubsonicRoutesLive = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* Auth
    const stream = yield* Stream
    const scanner = yield* Scanner
    const sql = yield* SqlClient.SqlClient

    type Handler = (
      userId: number,
      isAdmin: boolean,
      params: Params,
    ) => Effect.Effect<globalThis.Response, unknown, unknown>

    const ok = (children?: Readonly<Record<string, SChild>>) =>
      subsonicResponse(envelope.ok(children), "json")

    /** Response → HttpServerResponse（路由返回类型统一） */
    const toResponse = (effect: Effect.Effect<globalThis.Response>) =>
      Effect.map(effect, (response) => HttpServerResponse.fromWeb(response))

    const songRows = (effect: Effect.Effect<unknown, unknown, unknown>) =>
      Effect.map(effect, (rows) => rowsOf(rows).map(songNode))

    // ---- 端点实现 ----

    const handlers: Readonly<Record<string, Handler>> = {
      ping: () => ok(),

      getUser: (userId, isAdmin, params) => {
        const username = first(params, "username")
        void username
        return ok({
          user: node("user", {
            username: username ?? "user",
            email: "",
            scrobblingEnabled: true,
            adminRole: isAdmin,
            settingsRole: isAdmin,
            downloadRole: true,
            uploadRole: false,
            playlistRole: true,
            coverArtRole: true,
            commentRole: true,
            podcastRole: false,
            streamRole: true,
            jukeboxRole: false,
            shareRole: false,
            videoConversionRole: false,
          }),
        })
      },

      getOpenSubsonicExtensions: () =>
        ok({ openSubsonicExtensions: [] }),

      getMusicFolders: () =>
        Effect.flatMap(SubsonicRepo.folders, (folders) =>
          ok({
            musicFolders: node("musicFolders", {}, {
              musicFolder: folders.map((f) =>
                node("musicFolder", { id: Number(f.id), name: String(f.name) })),
            }),
          })),

      getIndexes: (_userId, _isAdmin, params) =>
        Effect.flatMap(SubsonicRepo.folders, (folders) => {
          const folderId = int(params, "musicFolderId") ?? Number(folders[0]?.id ?? 1)
          return Effect.flatMap(
            infra(SubsonicRepo.dirChildDirs(sql, folderId, "")),
            (dirRows) => {
              const topDirs = rowsOf(dirRows).map((row) => String(row.name)).sort()
              const indexes = groupByIndex(topDirs, (name) => name).map(
                ({ name, list }) =>
                  node("index", { name }, {
                    artist: list.map((dir) =>
                      node("artist", { id: dirId(folderId, dir), name: dir })),
                  }),
              )
              return ok({
                indexes: node("indexes", { lastModified: 0, ignoredArticles: "" }, { index: indexes }),
              })
            },
          )
        }),

      getMusicDirectory: (_userId, _isAdmin, params) => {
        const id = first(params, "id") ?? ""
        const dir = parseDirId(id)
        const folderId = dir?.folderId ?? (/^\d+$/.test(id) ? Number(id) : null)
        if (folderId === null) {
          return subsonicResponse(envelope.error(SUBSONIC_ERRORS.requestedDataNotFound, "directory not found"), "json")
        }
        const rel = dir?.rel ?? ""
        const prefix = rel === "" ? "" : `${rel}/`
        return Effect.flatMap(
          Effect.all({
            dirRows: infra(SubsonicRepo.dirChildDirs(sql, folderId, rel)),
            fileRows: infra(SubsonicRepo.dirChildFiles(sql, folderId, rel)),
          }),
          ({ dirRows, fileRows }) => {
            const dirs = rowsOf(dirRows).map((row) => String(row.name)).sort()
            const files = rowsOf(fileRows)
            const childDirNodes = dirs.map((name) =>
              node("child", {
                id: dirId(folderId, prefix + name),
                parent: rel === "" ? String(folderId) : dirId(folderId, rel),
                isDir: true,
                title: name,
                artist: "",
              }))
            const songQuery = files.length === 0
              ? Effect.succeed([])
              : Effect.map(
                infra(sql`select ${sql.literal(songColsFor(_userId))} ${sql.literal(songFrom)}
                    where t.id in ${sql.in(files.map((f) => Number(f.id)))} order by t.path asc`),
                (rows: unknown) => rowsOf(rows).map((row) => songNode(row)),
              )
            return Effect.flatMap(songQuery, (songNodes) =>
            ok({
              directory: node(
                "directory",
                {
                  id: rel === "" ? String(folderId) : id,
                  parent: rel === "" ? undefined : dirId(folderId, rel.split("/").slice(0, -1).join("/")),
                  name: rel === "" ? "" : rel.split("/").pop()!,
                },
                { child: [...childDirNodes, ...songNodes] },
              ),
            }))
        })
      },

      getArtists: (userId) =>
        Effect.flatMap(SubsonicRepo.artistsAll(sql, userId), (rows) => {
          const artists = rowsOf(rows)
          const indexes = groupByIndex(artists, (row) => String(row.name)).map(({ name, list }) =>
            node("index", { name }, { artist: list.map(artistListEntryNode) }))
          return ok({
            artists: node("artists", { lastModified: 0, ignoredArticles: "" }, { index: indexes }),
          })
        }),

      getArtist: (userId, _isAdmin, params) => {
        const artistId = int(params, "id")
        if (artistId === undefined) return missingParam()
        return Effect.flatMap(
          Effect.all([
            SubsonicRepo.artistById(sql, userId, artistId),
            SubsonicRepo.albumsByArtist(sql, userId, artistId),
          ]),
          ([artistRows, albumRows]) => {
            const artist = rowOf(artistRows)
            if (artist === undefined) {
              return notFoundResponse()
            }
            return ok({
              artist: node(
                "artist",
                { ...artistNode(artist).attrs },
                { album: rowsOf(albumRows).map(albumNode) },
              ),
            })
          },
        )
      },

      getAlbum: (userId, _isAdmin, params) => {
        const albumId = int(params, "id")
        if (albumId === undefined) return missingParam()
        return Effect.flatMap(
          Effect.all([
            SubsonicRepo.albumById(sql, userId, albumId),
            SubsonicRepo.songsByAlbum(sql, userId, albumId),
          ]),
          ([albumRows, songRowsRaw]) => {
            const album = rowOf(albumRows)
            if (album === undefined) return notFoundResponse()
            return ok({
              album: node(
                "album",
                { ...albumNode(album).attrs },
                { song: rowsOf(songRowsRaw).map(songNode) },
              ),
            })
          },
        )
      },

      getSong: (userId, _isAdmin, params) => {
        const id = int(params, "id")
        if (id === undefined) return missingParam()
        return Effect.flatMap(SubsonicRepo.songById(sql, userId, id), (rows) => {
          const row = rowOf(rows)
          return row === undefined ? notFoundResponse() : ok({ song: songNode(row) })
        })
      },

      getAlbumList2: (userId, _isAdmin, params) => {
        const type = first(params, "type") ?? "alphabeticalByName"
        const size = Math.min(int(params, "size") ?? 10, 500)
        const offset = int(params, "offset") ?? 0
        return Effect.flatMap(
          SubsonicRepo.albumsList(sql, userId, type, size, offset, {
            fromYear: int(params, "fromYear"),
            toYear: int(params, "toYear"),
            genre: first(params, "genre"),
          }),
          (rows) =>
            ok({ albumList2: node("albumList2", {}, { album: rowsOf(rows).map(albumNode) }) }),
        )
      },

      getGenres: () =>
        Effect.flatMap(SubsonicRepo.genres(sql), (rows) =>
          ok({
            genres: node("genres", {}, {
              genre: rowsOf(rows).map((row) =>
                node("genre", {
                  value: String(row.value),
                  songCount: Number(row.song_count ?? 0),
                  albumCount: Number(row.album_count ?? 0),
                })),
            }),
          })),

      getSongsByGenre: (userId, _isAdmin, params) => {
        const genre = first(params, "genre")
        if (genre === undefined) return missingParam()
        const count = Math.min(int(params, "count") ?? 10, 500)
        const offset = int(params, "offset") ?? 0
        return songRows(SubsonicRepo.songsByGenre(sql, userId, genre, count, offset)).pipe(
          Effect.flatMap((song) => ok({ songsByGenre: node("songsByGenre", {}, { song }) })),
        )
      },

      getRandomSongs: (userId, _isAdmin, params) =>
        songRows(
          SubsonicRepo.songsRandom(
            sql,
            userId,
            Math.min(int(params, "size") ?? 10, 500),
            first(params, "genre") ?? null,
            int(params, "fromYear") ?? null,
            int(params, "toYear") ?? null,
          ),
        ).pipe(Effect.flatMap((song) => ok({ randomSongs: node("randomSongs", {}, { song }) }))),

      getStarred: (userId) =>
        Effect.flatMap(
          Effect.all([
            SubsonicRepo.starredArtists(sql, userId),
            SubsonicRepo.starredAlbums(sql, userId),
            SubsonicRepo.starredSongs(sql, userId),
          ]),
          ([artists, albums, songs]) =>
            ok({
              starred: node("starred", {}, {
                artist: rowsOf(artists).map(artistListEntryNode),
                album: rowsOf(albums).map(albumNode),
                song: rowsOf(songs).map(songNode),
              }),
            }),
        ),

      getStarred2: (userId) =>
        Effect.flatMap(
          Effect.all([
            SubsonicRepo.starredArtists(sql, userId),
            SubsonicRepo.starredAlbums(sql, userId),
            SubsonicRepo.starredSongs(sql, userId),
          ]),
          ([artists, albums, songs]) =>
            ok({
              starred2: node("starred2", {}, {
                artist: rowsOf(artists).map(artistListEntryNode),
                album: rowsOf(albums).map(albumNode),
                song: rowsOf(songs).map(songNode),
              }),
            }),
        ),

      search3: (userId, _isAdmin, params) => {
        const query = first(params, "query") ?? ""
        const artistCount = int(params, "artistCount") ?? 20
        const artistOffset = int(params, "artistOffset") ?? 0
        const albumCount = int(params, "albumCount") ?? 20
        const albumOffset = int(params, "albumOffset") ?? 0
        const songCount = int(params, "songCount") ?? 20
        const songOffset = int(params, "songOffset") ?? 0
        return Effect.flatMap(
          Effect.all([
            query === ""
              ? Effect.succeed([])
              : SubsonicRepo.searchArtists(sql, userId, query, artistCount, artistOffset),
            query === ""
              ? Effect.succeed([])
              : SubsonicRepo.searchAlbums(sql, userId, query, albumCount, albumOffset),
            query === ""
              ? Effect.succeed([])
              : SubsonicRepo.searchSongs(sql, userId, query, songCount, songOffset),
          ]),
          ([artists, albums, songs]) =>
            ok({
              searchResult3: node("searchResult3", {}, {
                artist: rowsOf(artists).map(artistListEntryNode),
                album: rowsOf(albums).map(albumNode),
                song: rowsOf(songs).map(songNode),
              }),
            }),
        )
      },

      getArtistInfo2: () =>
        ok({ artistInfo2: node("artistInfo2", { biography: "", musicBrainzId: "", lastFmUrl: "" }) }),

      getAlbumInfo2: () => ok({ albumInfo: node("albumInfo", { notes: "" }) }),

      getTopSongs: (userId, _isAdmin, params) => {
        const artistId = int(params, "artistId") ?? int(params, "id")
        if (artistId === undefined) return missingParam()
        const count = Math.min(int(params, "count") ?? 50, 500)
        return songRows(SubsonicRepo.songsByArtistTop(sql, userId, artistId, count)).pipe(
          Effect.flatMap((song) => ok({ topSongs: node("topSongs", {}, { song }) })),
        )
      },

      getSimilarSongs: (userId, _isAdmin, params) => similarSongs(userId, params, sql),
      getSimilarSongs2: (userId, _isAdmin, params) => similarSongs(userId, params, sql),

      getPlaylists: (userId) =>
        Effect.flatMap(PlaylistRepo.listFor(userId), (playlists) =>
          ok({
            playlists: node("playlists", {}, { playlist: playlists.map(playlistNode) }),
          })),

      getPlaylist: (userId, _isAdmin, params) => {
        const playlistId = int(params, "id")
        if (playlistId === undefined) return missingParam()
        return Effect.flatMap(
          PlaylistRepo.visible(playlistId, userId),
          (playlist) =>
            Effect.flatMap(PlaylistRepo.trackIds(playlistId), (trackIds) =>
              Effect.flatMap(
                trackIds.length === 0
                  ? Effect.succeed([])
                  : infra(sql`select ${sql.literal(songColsFor(userId))} ${sql.literal(songFrom)}
                        where t.id in ${sql.in(trackIds)} order by t.path asc`),
                (rows: unknown) =>
                  ok({
                    playlist: node(
                      "playlist",
                      playlistNodeAttrs(playlist),
                      { entry: rowsOf(rows).map(songNode) },
                    ),
                  }),
              )),
        )
      },

      createPlaylist: (userId, _isAdmin, params) => {
        // 带 playlistId = 全量替换曲目；否则用 name 新建
        const playlistId = int(params, "playlistId")
        const songIds = [...new Set(many(params, "songId").map(Number))]
        const name = first(params, "name")
        if (playlistId !== undefined) {
          return Effect.flatMap(
            PlaylistRepo.visible(playlistId, userId),
            (playlist) =>
              playlist.ownerUserId !== userId
                ? subsonicResponse(envelope.error(SUBSONIC_ERRORS.notAuthorized, "not the playlist owner"), "json")
                : Effect.flatMap(
                  PlaylistRepo.replaceTracks(playlistId, songIds),
                  () => handlers["getPlaylist"]!(userId, false, params),
                ),
          )
        }
        if (name === undefined) return missingParam()
        return Effect.flatMap(
          PlaylistRepo.create(userId, name, null, false),
          (id) =>
            Effect.flatMap(
              PlaylistRepo.replaceTracks(id, songIds),
              () => handlers["getPlaylist"]!(userId, false, { id: String(id) } as Params),
            ),
        )
      },

      updatePlaylist: (userId, _isAdmin, params) => {
        const playlistId = int(params, "playlistId")
        if (playlistId === undefined) return missingParam()
        const name = first(params, "name")
        const comment = first(params, "comment")
        const isPublic = first(params, "public")
        const songIdToAdd = many(params, "songIdToAdd").map(Number)
        const songIndexToRemove = many(params, "songIndexToRemove").map(Number)
        return Effect.flatMap(
          PlaylistRepo.visible(playlistId, userId),
          (playlist) =>
            playlist.ownerUserId !== userId
              ? subsonicResponse(envelope.error(SUBSONIC_ERRORS.notAuthorized, "not the playlist owner"), "json")
              : Effect.flatMap(
                PlaylistRepo.updateMeta(playlistId, {
                  name: name ?? undefined,
                  comment: comment ?? null,
                  isPublic: isPublic === undefined ? undefined : isPublic === "true",
                }),
                () =>
                  Effect.flatMap(
                    PlaylistRepo.editTracks(playlistId, songIdToAdd, songIndexToRemove),
                    () => ok(),
                  ),
              ),
        )
      },

      deletePlaylist: (userId, _isAdmin, params) => {
        const playlistId = int(params, "id")
        if (playlistId === undefined) return missingParam()
        return Effect.flatMap(
          PlaylistRepo.visible(playlistId, userId),
          (playlist) =>
            playlist.ownerUserId !== userId
              ? subsonicResponse(envelope.error(SUBSONIC_ERRORS.notAuthorized, "not the playlist owner"), "json")
              : Effect.flatMap(PlaylistRepo.delete(playlistId), () => ok()),
        )
      },

      star: (userId, _isAdmin, params) => {
        const ids = many(params, "id").map(Number)
        const albumIds = many(params, "albumId").map(Number)
        const artistIds = many(params, "artistId").map(Number)
        return Effect.flatMap(
          Effect.all([
            ids.length > 0 ? AnnotationRepo.star(userId, "track", ids) : Effect.void,
            albumIds.length > 0 ? AnnotationRepo.star(userId, "album", albumIds) : Effect.void,
            artistIds.length > 0 ? AnnotationRepo.star(userId, "artist", artistIds) : Effect.void,
          ]),
          () => ok(),
        )
      },

      unstar: (userId, _isAdmin, params) => {
        const ids = many(params, "id").map(Number)
        const albumIds = many(params, "albumId").map(Number)
        const artistIds = many(params, "artistId").map(Number)
        return Effect.flatMap(
          Effect.all([
            ids.length > 0 ? AnnotationRepo.unstar(userId, "track", ids) : Effect.void,
            albumIds.length > 0 ? AnnotationRepo.unstar(userId, "album", albumIds) : Effect.void,
            artistIds.length > 0 ? AnnotationRepo.unstar(userId, "artist", artistIds) : Effect.void,
          ]),
          () => ok(),
        )
      },

      setRating: (userId, _isAdmin, params) => {
        const raw = first(params, "id") ?? ""
        const rating = int(params, "rating")
        if (rating === undefined) return missingParam()
        if (/^al-/.test(raw)) {
          return Effect.flatMap(
            AnnotationRepo.setRating(userId, "album", Number(raw.slice(3)), rating),
            () => ok(),
          )
        }
        if (/^ar-/.test(raw)) {
          return Effect.flatMap(
            AnnotationRepo.setRating(userId, "artist", Number(raw.slice(3)), rating),
            () => ok(),
          )
        }
        return Effect.flatMap(
          AnnotationRepo.setRating(userId, "track", Number(raw), rating),
          () => ok(),
        )
      },

      scrobble: (userId, _isAdmin, params) => {
        const ids = many(params, "id").map(Number)
        if (ids.length === 0) return missingParam()
        const time = int(params, "time")
        const submission = first(params, "submission") !== "false"
        if (!submission) {
          // now-playing：MVP 不持久化（docs/04 §2.8）
          return ok()
        }
        // Subsonic 规范 time 为毫秒；兼容秒值（阈值 1e11：ms 侧=1973 前，秒侧=5138 后，均非法）
        const playedAt = time !== undefined ? new Date(time > 1e11 ? time : time * 1000) : new Date()
        return Effect.flatMap(
          Effect.forEach(ids, (trackId) => PlayRepo.record(userId, trackId, playedAt), {
            discard: true,
          }),
          () => ok(),
        )
      },

      stream: (_userId, _isAdmin, params) => {
        const id = first(params, "id")
        if (id === undefined) return missingParam()
        return Effect.catchTag(
          stream.stream(id, {
            format: first(params, "format"),
            maxBitRate: int(params, "maxBitRate"),
            timeOffset: int(params, "timeOffset"),
          }, undefined),
          "NotFound",
          () => notFoundResponse(),
        )
      },

      download: (_userId, _isAdmin, params) => {
        const id = first(params, "id")
        if (id === undefined) return missingParam()
        return Effect.catchTag(stream.download(id), "NotFound", () => notFoundResponse())
      },

      getCoverArt: (_userId, _isAdmin, params) => {
        const id = first(params, "id")
        if (id === undefined) return missingParam()
        return Effect.catchTag(stream.cover(id), "NotFound", () => notFoundResponse())
      },

      getScanStatus: () =>
        Effect.flatMap(scanner.status, (status) =>
          ok({
            scanStatus: node("scanStatus", {
              scanning: status.state === "scanning",
              count: status.processed,
            }),
          })),

      startScan: (_userId, isAdmin) => {
        if (!isAdmin) {
          return subsonicResponse(
            envelope.error(SUBSONIC_ERRORS.notAuthorized, "admin required"),
            "json",
          )
        }
        return Effect.flatMap(
          Effect.option(scanner.start()),
          () => ok({ scanStatus: node("scanStatus", { scanning: true, count: 0 }) }),
        )
      },

      getInternetRadioStations: () =>
        ok({ internetRadioStations: node("internetRadioStations", {}) }),

      getLyrics: (_userId, _isAdmin, params) =>
        ok({
          lyrics: node("lyrics", { artist: first(params, "artist") ?? "", title: first(params, "title") ?? "" }, { }),
        }),

      jukeboxControl: () =>
        subsonicResponse(envelope.error(SUBSONIC_ERRORS.generic, "jukebox not supported"), "json"),
    }

    // ---- 公共子函数 ----

    function similarSongs(userId: number, params: Params, sqlClient: typeof sql): Effect.Effect<globalThis.Response, unknown, unknown> {
      const id = int(params, "id")
      if (id === undefined) return missingParam()
      const count = Math.min(int(params, "count") ?? 50, 500)
      return songRows(SubsonicRepo.songsSimilar(sqlClient, userId, id, count)).pipe(
        Effect.flatMap((song) => ok({ similarSongs: node("similarSongs2", {}, { song }) })),
      )
    }

    // ---- 分发 ----

    const subsonicInner: Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpRouter.Provided> =
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const searchParams: Readonly<Record<string, string | ReadonlyArray<string>>> =
          yield* HttpServerRequest.ParsedSearchParams
        const route = yield* HttpRouter.RouteContext
        const endpointRaw = route.params["endpoint"] ?? ""
        const endpoint = endpointRaw.replace(/\.view$/, "")
        const params: Params = searchParams

        const username = first(params, "u")
        if (username === undefined) {
          return yield* toResponse(
            subsonicResponse(
              envelope.error(SUBSONIC_ERRORS.missingParameter, "Required parameter is missing."),
              first(params, "f"),
            ))
        }
        const userResult = yield* Effect.exit(
          auth.bySubsonicParams({
            username,
            token: first(params, "t"),
            salt: first(params, "s"),
            password: first(params, "p"),
          }),
        )
        if (userResult._tag === "Failure") {
          return yield* toResponse(
            subsonicResponse(
              envelope.error(SUBSONIC_ERRORS.wrongUsernameOrPassword, "Wrong username or password."),
              first(params, "f"),
            ))
        }
        const user = userResult.value
        const handler = handlers[endpoint]
        if (handler === undefined) {
          return yield* toResponse(
            subsonicResponse(
              envelope.error(SUBSONIC_ERRORS.generic, `endpoint not implemented: ${endpoint}`),
              first(params, "f"),
            ))
        }
        const response = yield* handler(Number(user.id), user.is_admin, params) as unknown as
          Effect.Effect<globalThis.Response>
        return HttpServerResponse.fromWeb(response)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.map(
            Effect.logError("subsonic handler error", cause),
            () => HttpServerResponse.empty({ status: 500 }),
          )),
      )

    // v4：请求期依赖须为零——repo 函数请求时 yield SqlClient，用构建期捕获的客户端关闭
    const subsonicHandler = Effect.provideService(subsonicInner, SqlClient.SqlClient, sql)

    yield* router.add("*", "/rest/:endpoint", subsonicHandler)
  }))

// ---- helpers ----

function songColsFor(userId: number): string {
  return `
    t.id, t.title, t.disc, t.track_no, t.duration_seconds, t.bitrate_kbps, t.sample_rate_hz,
    t.channels, t.format, t.codec, t.size_bytes, t.path, t.created_at, t.track_no,
    ar.id as artist_id, ar.name as artist_name,
    al.id as album_id, al.name as album_name, al.year, al.genre,
    (t.has_embedded_cover or al.cover_file is not null
     or exists(select 1 from tracks te where te.album_id = al.id and te.has_embedded_cover)) as has_cover,
    (select an.starred_at from annotations an
       where an.user_id = ${userId} and an.item_type = 'track' and an.item_id = t.id) as starred_at,
    (select an.rating from annotations an
       where an.user_id = ${userId} and an.item_type = 'track' and an.item_id = t.id) as rating,
    (select count(*)::int from plays p where p.user_id = ${userId} and p.track_id = t.id) as play_count
  `.trim().replace(/\s+/g, " ")
}

const songFrom = `from tracks t
  join artists ar on ar.id = t.artist_id
  join albums al on al.id = t.album_id`

function playlistNodeAttrs(playlist: {
  id: number
  name: string
  comment: string | null
  isPublic: boolean
  ownerUsername: string
  songCount: number
  durationSeconds: number
  createdAt: string
  updatedAt: string
}): Record<string, string | number | boolean | undefined> {
  return {
    id: String(playlist.id),
    name: playlist.name,
    comment: playlist.comment ?? undefined,
    public: playlist.isPublic,
    owner: playlist.ownerUsername,
    songCount: playlist.songCount,
    duration: playlist.durationSeconds,
    created: `${playlist.createdAt.slice(0, 19)}Z`,
    changed: `${playlist.updatedAt.slice(0, 19)}Z`,
    coverArt: `pl-${String(playlist.id)}`,
  }
}

function playlistNode(playlist: Parameters<typeof playlistNodeAttrs>[0]) {
  return node("playlist", playlistNodeAttrs(playlist))
}

function missingParam() {
  return subsonicResponse(
    envelope.error(SUBSONIC_ERRORS.missingParameter, "Required parameter is missing."),
    "json",
  )
}

function notFoundResponse() {
  return subsonicResponse(
    envelope.error(SUBSONIC_ERRORS.requestedDataNotFound, "The requested data was not found."),
    "json",
  )
}

