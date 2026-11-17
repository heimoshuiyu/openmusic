import { parseFile } from "music-metadata"

/** A fast reader may throw on a perfectly valid long metadata packet (e.g. embedded art),
 * not just return an unknown duration. Retry once before crossing to a different parser. */
export async function readMediaTags(file: string) {
  let fast
  try { fast = await parseFile(file, { duration: false }) } catch { /* retry below */ }
  if (fast?.format.duration != null) return fast
  try { return await parseFile(file, { duration: true }) }
  catch (error) { if (fast) return fast; throw error }
}

type Tags = Record<string, string>
type Stream = {index:number; codec_type:string; tags?:Tags; disposition?:{attached_pic?:number; default?:number};
  channels?:number; sample_rate?:string; bit_rate?:string}
type Probe = {format?:{duration?:string;bit_rate?:string;tags?:Tags}; streams?:Stream[]}
const keys = "title,artist,album,album_artist,albumartist,track,tracknumber,disc,discnumber,date,year,genre,OPENMUSIC_YOUTUBE_ID,OPENMUSIC_YOUTUBE_UPLOAD_DATE"
const entries = `format=duration,bit_rate:format_tags=${keys}:stream=index,codec_type,sample_rate,channels,bit_rate:stream_disposition=default,attached_pic:stream_tags=${keys}`

export function probeMetadata({format, streams=[]}: Probe) {
  const primary = (kind:string) => {
    const media = streams.filter(s => s.codec_type === kind && !s.disposition?.attached_pic)
    return media.find(s => s.disposition?.default) ?? media[0]
  }
  const audio = primary('audio'), video = primary('video')
  if (!audio) return null // a video frame or a cover alone is not a music track
  // Fill holes per field, not per dictionary. Never take a title from a subtitle or cover stream.
  const sources = [format?.tags,audio.tags,video?.tags].map(dict => new Map(
    Object.entries(dict ?? {}).map(([k,v]) => [k.toLowerCase(),v.trim()]),
  ))
  const tag = (...aliases:string[]) => {
    for (const source of sources) for (const k of aliases) { const value=source.get(k); if(value) return value }
    return null
  }
  const integer = (s:string|null) => Number.parseInt(s ?? '',10) > 0 ? Number.parseInt(s!,10) : null
  return {
    title:tag('title'), artist:tag('artist'), album:tag('album'), albumArtist:tag('album_artist','albumartist'), genre:tag('genre'),
    trackNo:integer(tag('track','tracknumber')), disc:integer(tag('disc','discnumber')),
    year:tag('openmusic_youtube_id','openmusic_youtube_upload_date') ? null : integer(tag('date','year')),
    durationSeconds:Math.round(Number(format?.duration) || 0), sampleRateHz:Number(audio.sample_rate) || 0,
    channels:Number(audio.channels) || 0, bitrateKbps:Math.round((Number(audio.bit_rate) || (!video && Number(format?.bit_rate)) || 0)/1000),
    coverStream:streams.find(s => s.codec_type === 'video' && s.disposition?.attached_pic === 1)?.index ?? null,
    hasVideo:!!video,
  }
}

export async function ffprobeMeta(absPath: string) {
  try {
    // /proc/self in a child refers to ffprobe, not to the server holding the pinned directory handle.
    const file = absPath.replace(/^\/proc\/self\/fd\//, `/proc/${process.pid}/fd/`)
    const proc = Bun.spawn(['ffprobe','-v','error','-show_entries',entries,'-of','json',file],
      {stdout:'pipe',stderr:'ignore',signal:AbortSignal.timeout(15_000)})
    const [code, text] = await Promise.all([proc.exited,new Response(proc.stdout).text()])
    return code === 0 ? probeMetadata(JSON.parse(text)) : null
  } catch { return null }
}
