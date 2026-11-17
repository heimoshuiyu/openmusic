import { expect, test } from "bun:test"
import { youtubeSource, checkSubdirectory } from "./source"

test("rebuild trusted video / playlist URLs, never send the user's raw URL to an extractor", () => {
  for (const host of ["youtu.be/abcdefghijk", "www.youtube.com/watch?v=abcdefghijk&list=PLfoo", "music.youtube.com/watch?v=abcdefghijk", "youtube.com/shorts/abcdefghijk"]) {
    expect(youtubeSource("https://"+host)).toEqual({kind:"video",url:"https://www.youtube.com/watch?v=abcdefghijk"})
  }
  expect(youtubeSource("https://www.youtube.com/playlist?list=PLfoo&si=123")?.kind).toBe("playlist")
  for(const url of ["file:///etc/passwd","--exec=echo", "https://youtube.com.evil.com/watch?v=abcdefghijk","https://youtube.com@localhost/watch?v=abcdefghijk","http://youtube.com:555/watch?v=abcdefghijk","https://youtube.com/redirect?q=https://localhost"]) expect(youtubeSource(url)).toBeNull()
})
test("only existing descendants may be addressed by a relative subdirectory",()=>{
  expect(checkSubdirectory("")).toEqual([]); expect(checkSubdirectory("现场/2026")).toEqual(["现场","2026"])
  for(const name of ["/tmp","..","foo/../bar",".git","foo//bar","x\\y","ab\u0000cd"]) expect(checkSubdirectory(name)).toBeNull()
})
