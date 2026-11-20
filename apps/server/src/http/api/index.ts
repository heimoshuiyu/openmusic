import { HttpApi } from "effect/unstable/httpapi"
import { AgentGroup } from "./agent-schema"
import { AuthGroup, SessionGroup, UsersGroup } from "./auth-schema"
import { BrowseGroup } from "./browse-schema"
import { LibraryGroup } from "./library-schema"
import { PlaysGroup, PlaylistsGroup, SocialGroup } from "./social-schema"
import { SystemGroup } from "./system-schema"
import { YoutubeGroup } from "./youtube-schema"
import { NeteaseGroup } from "./netease-schema"
import { LyricsGroup } from './lyrics-schema'

/** 全部第一方 API 组的聚合（各 group 统一挂 /api/v1 前缀） */
export class Api extends HttpApi.make("api")
  .add(SystemGroup)
  .add(AuthGroup)
  .add(SessionGroup)
  .add(UsersGroup)
  .add(LibraryGroup)
  .add(BrowseGroup)
  .add(SocialGroup)
  .add(PlaysGroup)
  .add(PlaylistsGroup)
  .add(AgentGroup)
  .add(YoutubeGroup)
  .add(NeteaseGroup)
  .add(LyricsGroup)
{}
