import { describe, expect, test } from "bun:test"
import {
  AUDIO_EXTENSIONS,
  extensionForCodec,
  fromExtension,
  mimeForCodec,
} from "./codecs"

describe("codecs 映射表", () => {
  test("扩展名 → codec/mime", () => {
    expect(fromExtension("flac")).toEqual({ codec: "flac", mime: "audio/flac" })
    expect(fromExtension("mp3")).toEqual({ codec: "mp3", mime: "audio/mpeg" })
    expect(fromExtension("FLAC")).toEqual({ codec: "flac", mime: "audio/flac" }) // 大小写不敏感
    expect(fromExtension("m4a")).toEqual({ codec: "aac", mime: "audio/mp4" })
    expect(fromExtension("opus")).toEqual({ codec: "opus", mime: "audio/ogg" })
    expect(fromExtension("unknown")).toBeUndefined()
  })

  test("codec → mime", () => {
    expect(mimeForCodec("flac")).toBe("audio/flac")
    expect(mimeForCodec("wavpack")).toBe("audio/wavpack")
    expect(mimeForCodec("nonexistent")).toBe("application/octet-stream")
  })

  test("codec → 首选扩展名", () => {
    expect(extensionForCodec("mp3")).toBe("mp3")
    expect(extensionForCodec("vorbis")).toBe("ogg")
    expect(extensionForCodec("custom")).toBe("custom")
  })

  test("扫描白名单与表一致", () => {
    expect(AUDIO_EXTENSIONS.has("flac")).toBeTrue()
    expect(AUDIO_EXTENSIONS.has("dsf")).toBeTrue()
    expect(AUDIO_EXTENSIONS.has("txt")).toBeFalse()
    expect(AUDIO_EXTENSIONS.has("mp4")).toBeTrue()
  })
})
