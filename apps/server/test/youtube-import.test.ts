import { expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ImportResult } from "../src/domain/youtube"
import { parseFile } from "music-metadata"
import { migrateTestDb, truncateDomainTables, startServer, TestServer, TEST_DB_URL } from "./helpers"
import { Pool } from "pg"

test("YouTube import: search → start in a validated destination → audio + targeted index", async () => {
  await migrateTestDb(); await truncateDomainTables(true)
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(),"om-import-test-")), previous=process.env.PATH
  const app=await startServer(), a=new TestServer(app.handler), b=new TestServer(app.handler)
  const base="/api/v1/imports/youtube", library=path.join(tmp,"Library"), dest=path.join(library,"Singles")
  const originalFetch=globalThis.fetch
  try {
    const image=(color:string)=>Bun.spawnSync(["ffmpeg","-v","error","-f","lavfi","-i",`color=c=${color}:s=40x40`,"-frames:v","1","-c:v","mjpeg","-f","image2pipe","pipe:1"]).stdout
    const red=image("red"), blue=image("blue")
    globalThis.fetch=Object.assign((arg:Parameters<typeof fetch>[0],init?:RequestInit)=>{
      const u=new URL(arg instanceof Request?arg.url:arg.toString())
      if(u.hostname==="i.ytimg.com")return Promise.resolve(new Response(new Uint8Array(red)))
      if(u.hostname==='www.youtube.com' && u.pathname==='/api/timedtext')return Promise.resolve(Response.json({events:Array.from({length:81},(_,i)=>({tStartMs:i*500,dDurationMs:450,segs:[{utf8:`Line ${i}`}]}))}))
      if(u.hostname==="itunes.apple.com")return Promise.resolve(Response.json({results:[{kind:"song",trackName:"Imported fixture",artistName:"Test Singer",collectionName:"Test Album",primaryGenreName:"Rock",trackTimeMillis:1000}]}))
      return originalFetch(arg,init)
    },{preconnect:originalFetch.preconnect})
    await fs.mkdir(dest,{recursive:true});await fs.symlink(tmp,path.join(library,"escape"))
    // Local deterministic executable: non-network search/playlist fixture + real decodable audio.
    await fs.writeFile(path.join(tmp,"yt-dlp"),`#!/bin/sh
case "$*" in *'--no-write-auto-subs'*) printf '%s\\n' '{"id":"abcdefghijk","subtitles":{"ja":[{"ext":"json3","url":"https://www.youtube.com/api/timedtext?v=abcdefghijk"}]},"automatic_captions":{"en":[]}}';;
*--dump-json*) printf '%s\\n' '{"id":"abcdefghijk","title":"Fixture","channel":"Fixture"}' '{"id":"lmnopqrstuv","title":"Fixture 2"}';;
*) for arg do last="$arg"; done
case "$*" in
  *'--audio-format mp3'*) ext=mp3; codec=libmp3lame;;
  *'--audio-format best'*) case "$last" in *lmnopqrstuv) ext=m4a;codec=aac;; *) ext=opus;codec=libopus;; esac;;
  *'--merge-output-format mp4'*) ext=mp4;codec=aac;;
  *) exit 3;;
esac
set -- ffmpeg -loglevel error -f lavfi -i sine=frequency=400:duration=1
if [ "$ext" = mp4 ]; then set -- "$@" -f lavfi -i color=c=green:size=32x32:duration=1 -map 1:v -map 0:a -c:v libx264; fi
"$@" -c:a "$codec" -metadata title="Imported fixture" -metadata artist="Test Singer" "audio.$ext" || exit 1
case "$last" in *unsupported) python3 -c 'from pathlib import Path;f=Path("audio.mp3");b=f.read_bytes();assert b[:3]==b"ID3";f.write_bytes(b[:3]+bytes([5])+b[4:])' || exit 1;; esac
printf '{"id":"%s","upload_date":"20261003","track":"Imported fixture","artist":"Test Singer","duration":1}\\n' "\${last##*=}";; esac\n`,{mode:0o700})
    process.env.PATH=`${tmp}:${previous}`
    expect((await a.post(base+"/requests",{url:"https://youtu.be/abcdefghijk",folderId:"1"})).status).toBe(401); await a.login()
    expect((await a.post("/api/v1/users",{username:"importer",password:"user123456",isAdmin:false})).status).toBe(200);await b.login("importer","user123456")
    expect((await b.post("/api/v1/music-folders",{name:"bad",path:tmp})).status).toBe(403)
    const f=await a.post("/api/v1/music-folders",{name:"Test music",path:library});const folderId=(f.body as {id:string}).id
    const candidates=await b.post(base+"/search",{query:"Fixture"});expect(candidates.status).toBe(200)
    const url="https://www.youtube.com/playlist?list=PLtest"
    const start=(video:string,subdirectory:string)=>b.post(base+"/requests",{url:video,folderId,subdirectory,format:"mp3"})
    expect((await b.post(base+"/requests",{url})).status).not.toBe(200)
    for(const invalid of ["../","/tmp","escape","missing"]) expect((await start(url,invalid)).status).toBe(422)
    expect((await b.post(base+"/requests",{url,folderId,sessionID:"someone-elses-session"})).status).toBe(404)
    expect(await fs.readdir(dest)).toEqual([])
    const replies=await Promise.all([1,2].map(()=>start(url,"Singles")));expect(replies.map(r=>r.status)).toEqual([200,200]);const j=replies[0]!.body as ImportResult
    expect(replies[1]!.body).toEqual(j)
    const caps=base+'/captions',ref={trackId:String(j.trackIds[0])}
    expect((await new TestServer(app.handler).post(caps+'/list',ref)).status).toBe(401)
    expect((await b.post(caps+'/list',{...ref,url:'https://youtu.be/abcdefghijk'})).status).toBe(422)
    expect((await b.post(caps+'/list',ref)).body).toEqual({videoId:'abcdefghijk',tracks:[{language:'ja',kind:'manual'}]})
    const readCaps=(extra:object)=>b.post(caps+'/read',{url:'https://youtu.be/abcdefghijk',language:'ja',...extra})
    expect((await readCaps({})).body).toMatchObject({kind:'manual',nextOffset:80,total:81})
    expect((await readCaps({offset:80})).body).toMatchObject({cues:[{startMs:40000,endMs:40450,text:'Line 80'}],nextOffset:null})
    expect((await readCaps({language:'en'})).status).toBe(422)
    expect((await readCaps({kind:'automatic'})).status).toBe(400)
    expect(j).toMatchObject({state:"done",imported:2,destination:dest,failures:[]});expect(j.trackIds).toHaveLength(2);expect(await fs.readdir(dest)).toHaveLength(2)
    const tracks=(await b.get("/api/v1/tracks")).body as {items:{title:string}[]};expect(tracks.items.some(t=>t.title==="Imported fixture")).toBe(true)
    expect((await b.get("/api/v1/library/scan-status")).body).toMatchObject({state:"idle",lastScanAt:null})
    expect((await start("https://youtu.be/abcdefghijk","Singles")).body).toMatchObject({state:"done",skipped:1,trackIds:[j.trackIds[0]]})
    // A collision with an unindexed file is not a playable track; keep the other result.
    await fs.writeFile(path.join(library,"YouTube-abcdefghijk.mp3"),"occupied")
    expect((await start(url,"")).body).toMatchObject({state:"partial",imported:1,failed:1,failures:[{videoId:"abcdefghijk"}]})
    expect((await start("https://youtu.be/abcdefghijk","")).body).toMatchObject({state:"failed",trackIds:[]})
    const id=j.trackIds[0], endpoint=`${base}/tracks/${id}/metadata`,cover=`/api/v1/covers/tr-${id}`
    expect((await b.get(endpoint)).body).toMatchObject({trackId:String(id),uploadDate:"2026-10-03",coverSource:"youtube",hasCover:true,album:"Test Album",genre:"Rock"})
    const oldCover=await b.get(cover);expect(oldCover.status).toBe(200)
    expect((await a.post("/api/v1/users",{username:"another",password:"user123456",isAdmin:false})).status).toBe(200)
    const other=new TestServer(app.handler);await other.login("another","user123456");expect((await other.patch(endpoint,{title:"denied"})).status).toBe(404)
    expect((await b.patch(endpoint,{title:"must not apply",cover:"http://127.0.0.1/private"})).status).toBe(422)
    const art="data:image/jpeg;base64,"+blue.toString("base64")
    const albumOf=async(tid:number)=>((await b.get(`/api/v1/tracks/${tid}`)).body as {album:{id:string}}).album.id
    const existingAlbum=await albumOf(id!)
    expect((await b.patch(endpoint,{album:"Temporary sole track"})).status).toBe(200)
    const temporary=await albumOf(id!)
    expect((await b.get(`/api/v1/albums/${existingAlbum}`)).status).toBe(200) // another file still references it
    const edited=await b.patch(endpoint,{album:"Live Edition",artist:"Original feat. Singer",title:"Live fixture",genre:"Jazz",cover:art})
    expect(edited.status).toBe(200);expect(edited.body).toMatchObject({trackId:String(id),title:"Live fixture",genre:"Jazz",album:"Live Edition",coverSource:"custom-image",uploadDate:"2026-10-03"})
    expect((await b.get(`/api/v1/albums/${temporary}`)).status).toBe(404) // immediate, without a scan
    const nextCover=await b.get(cover);expect(nextCover.status).toBe(200);expect(Buffer.compare(Buffer.from(oldCover.raw),Buffer.from(nextCover.raw))).not.toBe(0)
    const file=await parseFile(path.join(dest,"YouTube-abcdefghijk.mp3"));expect(file.common.album).toBe("Live Edition");expect(file.common.artist).toBe("Original feat. Singer");expect(file.common.picture?.length).toBe(1);expect(file.common.date).toBe("2026-10-03")
    expect((await b.patch(endpoint,{cover:"youtube"})).body).toMatchObject({coverSource:"youtube",trackId:String(id)})
    const inFormat=(v:string,format?:string)=>b.post(base+"/requests",{url:v,folderId,subdirectory:"Singles",format})
    expect((await inFormat(url,"flac")).status).toBe(400)
    const original=(await inFormat(url)).body as ImportResult
    expect(original).toMatchObject({format:"original",state:"done",imported:2})
    expect(original.files.map(f=>f.name)).toEqual(["YouTube-abcdefghijk.opus","YouTube-lmnopqrstuv.m4a"])
    expect((await inFormat(url,"original")).body).toMatchObject({skipped:2,trackIds:original.trackIds})
    const video=(await inFormat("https://youtu.be/abcdefghijk","video")).body as ImportResult
    expect(video).toMatchObject({state:"done",format:"video",imported:1})
    expect(video.files[0]!.name).toBe("YouTube-abcdefghijk.mp4")
    for (const {trackId,name} of [...original.files,...video.files]) {
      const metaUrl=`${base}/tracks/${trackId}/metadata`
      expect((await b.get(metaUrl)).body).toMatchObject({filename:name,format:name.endsWith(".mp4")?"video":"original",hasCover:true})
      expect((await b.patch(metaUrl,{title:"Retagged fixture",trackNumber:7,cover:art})).status).toBe(200)
      const m=await parseFile(path.join(dest,name));expect(m.common.title).toBe("Retagged fixture");expect(m.common.track.no).toBe(7);expect(m.common.picture?.length).toBe(1)
      expect((await b.get(`/api/v1/covers/tr-${trackId}`)).status).toBe(200)
    }
    const stream=await b.get(`/api/v1/tracks/${video.trackIds[0]}/stream?format=raw`)
    expect(stream.headers.get("content-type")).toBe("video/mp4")
    expect(await fs.readdir(dest)).toHaveLength(5)
    // Real readable MP3 with an ID3 revision Mutagen cannot edit. No unvalidated file fallback,
    // no fake embedded cover, no transcoding or replacement of a previously published file.
    const dbTags={title:'Database Title',album:'DB release',artist:'DB artist',albumArtist:'Release credit',genre:'DB genre',discNumber:2,trackNumber:4}
    const importUnsupported=(metadata:object)=>b.post(base+'/requests',{folderId,url:'https://youtu.be/unsupported',format:'mp3',metadata})
    expect((await importUnsupported({...dbTags,cover:'youtube'})).body).toMatchObject({state:'failed',trackIds:[]})
    const dbOnly=(await importUnsupported(dbTags)).body as ImportResult
    expect(dbOnly).toMatchObject({state:'done',warnings:[{videoId:'unsupported',message:expect.stringContaining('曲库')}]})
    const dbFile=dbOnly.files[0]!, dbEndpoint=`${base}/tracks/${dbFile.trackId}/metadata`, dbPath=path.join(library,dbFile.name)
    const dbBytes=await fs.readFile(dbPath)
    expect(dbBytes[3]).toBe(5)
    expect((await b.get(dbEndpoint)).body).toMatchObject({...dbTags,hasCover:false,coverSource:null})
    expect((await b.patch(dbEndpoint,{artist:'New artist'})).body).toMatchObject({...dbTags,artist:'New artist',warnings:[expect.any(String)]})
    expect(await fs.readFile(dbPath)).toEqual(dbBytes)

    // Persisted text wins even when the file says otherwise; unpinned fields still follow disk.
    // Same video, same directory, other version: original/MP3 must not inherit the video pins.
    const v=video.files[0]!, videoMeta=`${base}/tracks/${v.trackId}/metadata`
    expect((await b.patch(videoMeta,{album:'Pinned album',albumArtist:'Pinned credit'})).status).toBe(200)
    expect(Bun.spawnSync(['python3','-I','-c',`from mutagen.mp4 import MP4\nimport sys\nf=MP4(sys.argv[1]);f['©nam']=['Wrong title'];f['©alb']=['Wrong album'];f['aART']=['Wrong credit'];f['©ART']=['Changed unpinned artist'];f['trkn']=[(9,0)];f.save()`,path.join(dest,v.name)]).exitCode).toBe(0)
    for(const suffix of ['', '?force=true']) {
      expect((await a.post(`/api/v1/library/scan${suffix}`)).status).toBe(204);await a.waitScanIdle()
      expect((await b.get(videoMeta)).body).toMatchObject({title:'Retagged fixture',trackNumber:7,album:'Pinned album',albumArtist:'Pinned credit',artist:'Changed unpinned artist'})
      expect((await b.get(dbEndpoint)).body).toMatchObject({...dbTags,artist:'New artist',hasCover:false})
      expect((await b.get(endpoint)).body).toMatchObject({title:'Live fixture',album:'Live Edition'})
    }
    // Library removal is durable and never unlinks a media file. A forced scan here touches
    // ONLY the test Postgres container and this mkdtemp fixture folder.
    const opus=original.files[0]!,mp4=video.files[0]!, entry=`${base}/tracks/${opus.trackId}/library-entry`
    expect((await other.del(entry)).status).toBe(404)
    expect((await b.patch(`${base}/tracks/${opus.trackId}/metadata`,{album:"Only opus"})).status).toBe(200)
    const onlyOpus=await albumOf(opus.trackId)
    expect((await b.del(entry)).status).toBe(204)
    expect((await b.get(`/api/v1/albums/${onlyOpus}`)).status).toBe(404)
    expect(await fs.stat(path.join(dest,opus.name))).toBeTruthy()
    expect((await b.get(`${base}/tracks/${opus.trackId}/metadata`)).status).toBe(404)
    expect((await a.post("/api/v1/library/scan?force=true")).status).toBe(204);await a.waitScanIdle()
    expect((await inFormat("https://youtu.be/abcdefghijk","original")).body).toMatchObject({state:"failed",trackIds:[]})
    const ask=`${base}/tracks/${mp4.trackId}/file-deletion-requests`, disk=path.join(dest,mp4.name)
    expect((await other.post(ask)).status).toBe(404)
    const ticket=async()=>{const req=await b.post(ask);expect(req.status).toBe(200);expect(req.body).not.toHaveProperty("token");return `${base}/file-deletion-requests/${(req.body as {requestId:string}).requestId}`}
    const canceled=await ticket();expect((await b.del(canceled)).status).toBe(204);expect((await b.post(canceled+"/review")).status).toBe(404)
    const once=await ticket();expect((await other.post(once+"/review")).status).toBe(404)
    const {token}= (await b.post(once+"/review")).body as {token:string}
    expect((await b.post(once+"/confirm",{token:"invented",filename:mp4.name})).status).toBe(422)
    expect((await b.post(once+"/confirm",{token,filename:opus.name})).status).toBe(422)
    expect((await other.post(once+"/confirm",{token,filename:mp4.name})).status).toBe(404)
    // A different inode must never inherit a prior approval, even at the same path.
    await fs.rename(disk,disk+".saved");await fs.symlink(path.join(dest,opus.name),disk)
    expect((await b.post(once+"/confirm",{token,filename:mp4.name})).status).toBe(422)
    expect((await fs.lstat(disk)).isSymbolicLink()).toBe(true)
    await fs.unlink(disk);await fs.rename(disk+".saved",disk)
    const exp=await ticket();const now=Date.now
    try {Date.now=()=>now()+6*60_000;expect((await b.post(exp+"/review")).status).toBe(404)} finally {Date.now=now}
    // An FK that rejects the deletion after staging must leave both source and DB intact.
    const pool=new Pool({connectionString:TEST_DB_URL})
    try {
      await pool.query("create table yt_test_block_remove(id bigint references tracks(id))")
      await pool.query("insert into yt_test_block_remove values($1)",[mp4.trackId])
      const blocked=await ticket(), v=(await b.post(blocked+"/review")).body as {token:string}
      expect((await b.post(blocked+"/confirm",{token:v.token,filename:mp4.name})).status).toBe(422)
      expect(await Bun.file(disk).exists()).toBe(true);expect((await b.get(`${base}/tracks/${mp4.trackId}/metadata`)).status).toBe(200)
    } finally {await pool.query("drop table if exists yt_test_block_remove");await pool.end()}
    const fresh=await ticket(), review=await b.post(fresh+"/review")
    expect(review.body).toMatchObject({filename:mp4.name,path:disk,format:"video"})
    const payload={token:(review.body as {token:string}).token,filename:mp4.name}
    expect((await b.post(fresh+"/confirm",payload)).status).toBe(204)
    expect((await b.post(fresh+"/confirm",payload)).status).toBe(404)
    expect(await Bun.file(disk).exists()).toBe(false);expect(await Bun.file(path.join(dest,opus.name)).exists()).toBe(true)
    expect((await b.get(`${base}/tracks/${mp4.trackId}/metadata`)).status).toBe(404)
    expect((await b.get(endpoint)).status).toBe(200) // MP3 sibling remains intact
  } finally {globalThis.fetch=originalFetch;process.env.PATH=previous;await app.dispose();await fs.rm(tmp,{recursive:true,force:true})}
},30_000)
