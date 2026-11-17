import { HttpApiBuilder } from 'effect/unstable/httpapi'
import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { lyricService } from '../../service/lyrics'
import { CurrentUser } from '../middleware/session'
import { Api } from './index'

export const LyricsApiLive = HttpApiBuilder.group(Api,'lyrics',Effect.fn(function*(handlers){
  const lyrics=lyricService(yield* SqlClient.SqlClient)
  return handlers.handleAll({readLyrics:({params})=>lyrics.read(params.id),
    editLyrics:({params,payload})=>Effect.flatMap(CurrentUser,u=>lyrics.edit(Number(u.id),params.id,payload.text)),
    bindLyrics:({params,payload})=>Effect.flatMap(CurrentUser,u=>lyrics.bind(Number(u.id),params.id,payload))})
}))
