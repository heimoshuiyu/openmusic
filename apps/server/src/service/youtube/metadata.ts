import * as fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { YoutubeTags, type CatalogMatch } from "../../domain/youtube"
import type { MediaExt } from "./formats"
import type { MetadataOverrides } from "../../domain/metadata-overrides"

export const validTags = (value:unknown) => Schema.decodeUnknownSync(YoutubeTags)(value, {onExcessProperty:"error"})
export function uploadDay(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{8}$/.test(value)) return null
  const day = `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6)}`
  const date = new Date(day)
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(day) ? day : null
}

const maxImage = 4 * 1024 * 1024
export async function boundedFetch(url:URL|string, max:number, signal:AbortSignal) {
  const response = await fetch(url,{redirect:"error", signal:AbortSignal.any([signal,AbortSignal.timeout(6500)])})
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel(); throw Error("资源不可用或过大")
  }
  const reader = response.body.getReader(), chunks:Uint8Array[]=[]; let size=0
  try { for (;;) { const {done,value}=await reader.read(); if (done) break
    size+=value.byteLength; if(size>max){await reader.cancel();throw Error("资源过大")};chunks.push(value)
  }} finally {reader.releaseLock()}
  return Buffer.concat(chunks,size)
}

export function allowedArtwork(raw:string) {
  const u=URL.parse(raw)
  if(!u || u.protocol!=="https:" || u.username || u.password || u.port || u.search || u.hash) return false
  return (u.hostname==="i.ytimg.com" && /^\/vi(?:_webp)?\/[\w-]{11}\/[\w-]+\.(?:jpg|webp)$/.test(u.pathname)) ||
    (/^is\d+(?:-ssl)?\.mzstatic\.com$/.test(u.hostname) && u.pathname.startsWith("/image/thumb/"))
}
export async function catalogSearch(query:string,country:string,signal:AbortSignal):Promise<(typeof CatalogMatch.Type)[]> {
  if (!query.trim() || query.length>160 || !/^[A-Z]{2}$/.test(country)) throw Error("无效的搜索参数")
  const url=new URL("https://itunes.apple.com/search");url.search=new URLSearchParams({term:query,country,entity:"song",limit:"8"}).toString()
  return catalogRows(url,signal)
}

async function catalogRows(url:URL,signal:AbortSignal) {
  const raw=JSON.parse((await boundedFetch(url,512*1024,signal)).toString("utf8"))
  if(!Array.isArray(raw.results)) throw Error("目录不可用")
  const text=(s:unknown)=>typeof s==="string"?s.trim().slice(0,300):""
  return (raw.results as Record<string,unknown>[]).slice(0,100).filter(r=>r?.kind==="song" && r.trackName && r.artistName).map(r=>({
    title:text(r.trackName),artist:text(r.artistName),album:text(r.collectionName),genre:text(r.primaryGenreName),
    durationSeconds:Math.round(Number(r.trackTimeMillis)||0)/1000,releaseDate:text(r.releaseDate).slice(0,10),
    trackNumber:Number(r.trackNumber)||0,discNumber:Number(r.discNumber)||0,source:text(r.trackViewUrl),
    cover:allowedArtwork(String(r.artworkUrl100)) ? String(r.artworkUrl100).replace(/\/100x100bb\./,"/600x600bb."):"",
  }))
}

export type VideoInfo = {id?:string; title?:string; channel?:string; description?:string; upload_date?:string; track?:string; artist?:string; album?:string; genre?:string; duration?:number}
const norm=(s:string)=>s.normalize("NFKC").trim().toLowerCase()
function appleRelease(link:string) {
  const u=URL.parse(link), m=u && /^\/([a-z]{2})\/album\/(?:[^/]+\/)?(\d{5,15})\/?$/i.exec(u.pathname)
  return u?.origin==='https://music.apple.com' && m ? {country:m[1]!.toUpperCase(),id:m[2]!}:null
}
/** Only a release linked in the source description may disambiguate a reissue.
 * Resolve at most one allowlisted smart link, with no redirects, scripts or arbitrary URLs. */
async function linkedRelease(description:string,signal:AbortSignal) {
  const urls=description.slice(0,6000).match(/https:\/\/[^\s<>"']+/g)??[]
  for(const url of urls){const release=appleRelease(url);if(release)return release}
  for(const raw of urls){const url=URL.parse(raw)
    if(!url || !/^[a-z0-9-]+\.lnk\.to$/.test(url.hostname) || url.username || url.password || url.port || !/^\/[\w-]+\/?$/.test(url.pathname))continue
    const html=(await boundedFetch(url.origin+url.pathname,1024*1024,signal)).toString("utf8")
    for(const a of html.matchAll(/\bhref=["'](https:\/\/music\.apple\.com\/[^"']+)["']/gi)){const release=appleRelease(a[1]!);if(release)return release}
    break
  }
  return null
}

export async function directoryMatch(info:VideoInfo,signal:AbortSignal) {
  if(!info.duration || (info.album && info.genre))return
  const release=await linkedRelease(info.description??"",signal)
  const title=info.track || info.title?.split(/\s+\/\s+/)[0], artist=info.artist || info.channel?.split(/\s+\/\s+/)[0]
  if(!title || !artist || (!release && (!info.track || !info.artist)))return
  let rows
  if(release){const url=new URL("https://itunes.apple.com/lookup");const jp=/[\u3040-\u30ff]/.test(title+artist)
    url.search=new URLSearchParams({entity:"song",id:release.id,country:jp?"JP":release.country,...(jp&&{lang:"ja_jp"})}).toString(); rows=await catalogRows(url,signal)}
  else rows=await catalogSearch(`${title} ${artist}`.slice(0,160),/[\u3040-\u30ff]/.test(title+artist)?"JP":"US",signal)
  // Refuse automatic enrichment for performance/arrangement qualifiers not present in the catalog title.
  const versions=(info.title??"").match(/\b(?:live|cover|remix|instrumental|acoustic|demo)\b|歌ってみた|ライブ/gi)??[]
  const hits=rows.filter(r=>norm(r.title)===norm(title) && norm(r.artist)===norm(artist) && Math.abs(r.durationSeconds-info.duration!)<=2 &&
    (!info.album || norm(r.album)===norm(info.album)) && versions.every(v=>norm(r.title).includes(norm(v))))
  return hits.length===1 ? hits[0]:undefined
}
export interface TagResult {uploadDate:string|null;coverSource:string|null;genre:string|null; overrides:MetadataOverrides; dbOnly:boolean; warnings:string[]}
export async function applyTags(dir:string,id:string,tags:YoutubeTags, info:VideoInfo, signal:AbortSignal,
  options:{ext:MediaExt;editing?:boolean;verifyLegacy?:boolean;knownDate?:string|null}):Promise<TagResult> {
  const uploadDate=uploadDay(info.upload_date) ?? options.knownDate ?? null, warnings:string[]=[]
  let coverSource:string|null=null, image:string|undefined
  let fields={...tags}
  // A channel name or a fuzzy match is not an artist credit. Never erase a version/vocal credit.
  if(!options.editing && info.id===id && (!tags.album || !tags.genre)) {
    try {
      const r=await directoryMatch(info,signal)
      if(r) fields={...(!info.album && r.album ? {album:r.album}:{}),...(!info.genre && r.genre ? {genre:r.genre}:{}),...fields}
    } catch {signal.throwIfAborted()}
  }
  const {cover,...textTags}=fields
  const wantThumb=cover==="youtube" || (!options.editing && !cover && info.id===id)
  if(cover && !wantThumb) {
    let bytes:Buffer
    if (cover.startsWith("data:")) {
      const base=/^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(cover)?.[1]
      if(!base || base.length>Math.ceil(maxImage/3)*4) throw Error("封面数据无效或过大")
      bytes=Buffer.from(base,"base64");coverSource="custom-image"
    } else {
      if(!allowedArtwork(cover)) throw Error("仅支持 YouTube / Apple 图片 CDN，其他图片请提交为 data:image")
      bytes=await boundedFetch(cover,maxImage,signal);coverSource=cover
    }
    if(!bytes.length || bytes.length>maxImage) throw Error("封面大小无效")
    image="cover-input";await fs.writeFile(path.join(dir,image),bytes)
  } else if(wantThumb) {
    for(const size of ["maxresdefault","hqdefault"]) {
      try {const bytes=await boundedFetch(`https://i.ytimg.com/vi/${id}/${size}.jpg`,maxImage,signal)
        await fs.writeFile(path.join(dir,"cover-input"),bytes);image="cover-input";coverSource="youtube";break
      } catch {signal.throwIfAborted()}
    }
    if(!image && cover) throw Error("未取得视频缩略图，未更换封面")
  }
  signal.throwIfAborted()
  const {cover:_cover,...overrides}=tags // never pin auto-enrichment or a base64 image
  const proc=Bun.spawn([process.env.OPENMUSIC_TAG_PYTHON || "python3","-I",path.join(import.meta.dir,"tag_media.py")],{
    cwd:dir,stdin:new Blob([JSON.stringify({ext:options.ext,videoId:id,tags:textTags,uploadDate,image,allowDbOnly:Object.keys(overrides).length>0,requiredImage:!!cover,verifyLegacy:options.verifyLegacy,newImport:!options.editing})]),
    stdout:"pipe",stderr:"ignore",signal:AbortSignal.any([signal,AbortSignal.timeout(15_000)]),
  })
  if(await proc.exited!==0) throw Error("媒体格式、标签或封面校验失败，原文件未修改")
  const written=JSON.parse(await new Response(proc.stdout).text());if(!written.coverApplied) coverSource=null
  if(written.dbOnly) warnings.push("未能嵌入文件标签；保留原文件，指定的文字元数据已存入曲库。未转码。")
  else if(!options.editing && !coverSource) warnings.push("未取得可用的 YouTube 缩略图，媒体仍已入库。")
  if(!options.editing && !uploadDate) warnings.push("YouTube 未提供有效上传日期。")
  return {uploadDate,coverSource,genre:overrides.genre??written.genre??null,overrides,dbOnly:written.dbOnly===true,warnings}
}
