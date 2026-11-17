import { describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { ffprobeMeta, probeMetadata, readMediaTags } from "./media-probe"

describe("ffprobe 兜底元数据提取（ffprobeMeta）", () => {
  test("long multi-page OpusTags: full reader and stream-tag fallback both recover credits", async () => {
    const dir = await fs.mkdtemp('/tmp/opencode/om-ogg-'), file = path.join(dir,'large.opus')
    try {
      expect(Bun.spawnSync(['ffmpeg','-v','error','-f','lavfi','-i','sine=duration=1',file]).exitCode).toBe(0)
      expect(Bun.spawnSync(['python3','-I','-c',
        `from mutagen.oggopus import OggOpus\nfrom mutagen.flac import Picture\nfrom PIL import Image\nfrom io import BytesIO\nimport sys,base64\nimg=BytesIO();Image.effect_noise((640,640),80).save(img,'JPEG',quality=95)\nf=OggOpus(sys.argv[1]);p=Picture();p.type=3;p.mime='image/jpeg';p.data=img.getvalue();f['metadata_block_picture']=[base64.b64encode(p.write()).decode()];f['artist']='Artist';f['title']='Off Vocal';f['tracknumber']='3';f.save()`,file]).exitCode).toBe(0)
      const metadata = await readMediaTags(file)
      expect(metadata.common).toMatchObject({artist:'Artist',title:'Off Vocal',track:{no:3}})
      expect(metadata.common.picture?.length).toBe(1)
      const handle=await fs.open(dir,'r')
      try { expect(await ffprobeMeta(`/proc/self/fd/${handle.fd}/large.opus`)).toMatchObject({artist:'Artist',trackNo:3,hasVideo:false,coverStream:1}) }
      finally {await handle.close()}
    } finally {await fs.rm(dir,{recursive:true,force:true})}
  })

  test("container tags win per field; default audio and real video can fill holes; artwork is not movie content", () => {
    const streams=[{index:0,codec_type:'video',tags:{TITLE:'Movie title',ALBUM:'Film'}},
      {index:1,codec_type:'audio',tags:{ARTIST:'Alternate'}},
      {index:2,codec_type:'audio',disposition:{default:1},tags:{artist:'Lead',TRACKNUMBER:'2/8'}},
      {index:3,codec_type:'video',disposition:{attached_pic:1},tags:{genre:'not music'}}]
    expect(probeMetadata({format:{tags:{title:'Container title',artist:'  '}},streams})).toMatchObject({
      title:'Container title',artist:'Lead',album:'Film',trackNo:2,genre:null,hasVideo:true,coverStream:3,
    })
    expect(probeMetadata({streams:streams.slice(1)})).toMatchObject({hasVideo:false,coverStream:3,title:null})
    expect(probeMetadata({streams:[streams[0]!]})).toBeNull()
  })
  test("正常 MP3：标签/时长/码率/采样率齐全", async () => {
    const dir = await fs.mkdtemp("/tmp/opencode/om-probe-")
    const file = path.join(dir, "t.mp3")
    const gen = Bun.spawnSync([
      "ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-metadata", "title=Probe Title", "-metadata", "artist=Probe Artist",
      "-metadata", "album=Probe Album", "-metadata", "track=3/12",
      "-metadata", "date=2010-03-24", "-metadata", "genre=Test",
      file,
    ])
    if (gen.exitCode !== 0) throw new Error("ffmpeg fixture failed")
    try {
      const meta = await ffprobeMeta(file)
      expect(meta).not.toBeNull()
      expect(meta!.title).toBe("Probe Title")
      expect(meta!.artist).toBe("Probe Artist")
      expect(meta!.album).toBe("Probe Album")
      expect(meta!.trackNo).toBe(3)
      expect(meta!.year).toBe(2010)
      expect(meta!.genre).toBe("Test")
      expect(meta!.durationSeconds).toBeGreaterThanOrEqual(2)
      expect(meta!.sampleRateHz).toBe(44100)
      expect(meta!.channels).toBeGreaterThanOrEqual(1)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("FLAC 的大写 Vorbis 键也能取到（大小写不敏感查找）", async () => {
    const dir = await fs.mkdtemp("/tmp/opencode/om-probe-")
    const file = path.join(dir, "t.flac")
    // FLAC 的 Vorbis 注释经 ffprobe 输出键名保持原样（ffprobe 会映射为小写——
    // 这里同时验证大小写归一查找对两种形态都稳）
    const gen = Bun.spawnSync([
      "ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=550:duration=2",
      "-metadata", "title=Upper Title", "-metadata", "album_artist=AA", file,
    ])
    if (gen.exitCode !== 0) throw new Error("ffmpeg fixture failed")
    try {
      const meta = await ffprobeMeta(file)
      expect(meta!.title).toBe("Upper Title")
      expect(meta!.albumArtist).toBe("AA")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("坏文件/不存在 → null（不抛）", async () => {
    expect(await ffprobeMeta("/nonexistent/nope.mp3")).toBeNull()
    const dir = await fs.mkdtemp("/tmp/opencode/om-probe-")
    const file = path.join(dir, "junk.mp3")
    await fs.writeFile(file, "this is not audio at all")
    try {
      expect(await ffprobeMeta(file)).toBeNull()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
