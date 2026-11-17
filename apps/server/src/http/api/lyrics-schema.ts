import { HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi'
import { TrackLyrics,LyricId,LyricBinding,LyricEdit,BindingResult } from '../../domain/lyrics'
import { BadRequest,NotFound,Forbidden } from '../../domain/errors'
import { SessionAuth } from '../middleware/session'

export class LyricsGroup extends HttpApiGroup.make('lyrics')
  .add(HttpApiEndpoint.get('readLyrics','/tracks/:id/lyrics',{params:{id:LyricId},success:TrackLyrics,error:[BadRequest,NotFound]}))
  .add(HttpApiEndpoint.put('editLyrics','/tracks/:id/lyrics',{params:{id:LyricId},payload:LyricEdit,success:BindingResult,error:[BadRequest,Forbidden,NotFound]}))
  .add(HttpApiEndpoint.put('bindLyrics','/tracks/:id/lyrics/binding',{params:{id:LyricId},payload:LyricBinding,success:BindingResult,error:[BadRequest,Forbidden,NotFound]}))
  .middleware(SessionAuth).prefix('/api/v1') {}
