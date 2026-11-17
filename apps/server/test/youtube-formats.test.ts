import { expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { outputSpec } from "../src/service/youtube/formats"
import { runDlp } from "../src/service/youtube/downloader"

// Exercise the installed yt-dlp's actual format selector and postprocessor offline.
// Compare compressed packets, not decoded samples/extension/bitrate, to detect re-encoding.
test("original preserves AAC and Opus packets; video preserves both media streams", async () => {
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),"om-ytdlp-formats-"))
  const cmd=(args:string[])=>{const p=Bun.spawnSync(args,{cwd:tmp});if(p.exitCode)throw Error(p.stderr.toString());return p.stdout.toString().trim()}
  const packets=(file:string,stream:string)=>cmd(["ffmpeg","-v","error","-i",file,"-map",stream,"-c","copy","-f","streamhash","-hash","sha256","-"])
  const http=Bun.serve({hostname:"127.0.0.1",port:0,fetch:req=>{
    const name=new URL(req.url).pathname.slice(1);return ["source.webm","source.m4a","source.mp4"].includes(name)?new Response(Bun.file(path.join(tmp,name))):new Response(null,{status:404})
  }})
  try {
    cmd(["ffmpeg","-v","error","-f","lavfi","-i","sine=frequency=521:duration=0.6","-c:a","libopus","source.webm"])
    cmd(["ffmpeg","-v","error","-f","lavfi","-i","sine=frequency=521:duration=0.6","-c:a","aac","source.m4a"])
    cmd(["ffmpeg","-v","error","-f","lavfi","-i","color=c=red:size=64x64:duration=0.6","-c:v","libx264","-an","source.mp4"])
    const media=(ext:string,vcodec:string,acodec:string)=>({url:`${http.url.origin}/source.${ext}`,ext,format_id:ext,vcodec,acodec,...(vcodec!=="none"&&{height:64,width:64})})
    const aac=media("m4a","none","mp4a.40.2"), opus=media("webm","none","opus"), video=media("mp4","avc1.42E01E","none")
    for (const [label,mode,formats,ext] of [["opus","original",[opus],"opus"],["aac","original",[aac],"m4a"],["video","video",[video,aac],"mp4"]] as const) {
      const dir=path.join(tmp,label);await fs.mkdir(dir)
      await fs.writeFile(path.join(dir,"fixture.json"),JSON.stringify({id:"abcdefghijk",title:"fixture",duration:1,extractor:"generic",extractor_key:"Generic",webpage_url:http.url.href,formats}))
      await runDlp(["--load-info-json","fixture.json",...outputSpec(mode).args,"--embed-metadata","-o","result.%(ext)s"],AbortSignal.timeout(15_000),dir)
      const file=path.join(dir,`result.${ext}`)
      expect(packets(file,"0:a:0")).toBe(packets(ext==="opus"?"source.webm":"source.m4a","0:a:0"))
      if(mode==="video") expect(packets(file,"0:v:0")).toBe(packets("source.mp4","0:v:0"))
    }
  } finally {http.stop(true);await fs.rm(tmp,{recursive:true,force:true})}
},45_000)
