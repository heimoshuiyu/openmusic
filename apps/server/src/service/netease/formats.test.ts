import { expect, test } from "bun:test"
import { importedFilename, neteaseName } from "./formats"

test("netease filenames carry the song id and only mp3/flac extensions", () => {
  expect(neteaseName("5264842", "mp3")).toBe("Netease-5264842.mp3")
  expect(importedFilename("Netease-5264842.mp3")).toEqual({ songId: "5264842", ext: "mp3" })
  expect(importedFilename("Netease-5264842.flac")).toEqual({ songId: "5264842", ext: "flac" })
  expect(importedFilename(neteaseName("2606227455", "flac"))).toEqual({ songId: "2606227455", ext: "flac" })
  // YouTube imports, other codecs and path tricks never collide with the netease namespace.
  for (const name of ["YouTube-abcdefghijk.mp3", "Netease-5264842.opus", "Netease-5264842.mp4", "Netease-.mp3",
    "Netease-5264842.MP3", "Netease-123456789012345678901.mp3", "../Netease-5264842.mp3", "netease-5264842.mp3"]) {
    expect(importedFilename(name)).toBeNull()
  }
})
