import { expect, test } from "bun:test"
import { allowedArtwork, directoryMatch, uploadDay, validTags } from "./metadata"

test("upload date must be an actual calendar day; not a guessed year or normalized invalid day",()=>{
  expect(uploadDay("20261003")).toBe("2026-10-03");expect(uploadDay("20260229")).toBeNull();expect(uploadDay("20240229")).toBe("2024-02-29");expect(uploadDay("2026")).toBeNull()
})
test("cover URLs cannot target other hosts, credentials, redirects or local files",()=>{
  expect(allowedArtwork("https://is1-ssl.mzstatic.com/image/thumb/Music/a/600x600bb.jpg")).toBe(true)
  for(const u of ["http://127.0.0.1/a.jpg","file:///etc/passwd","https://is1-ssl.mzstatic.com.evil.example/image/thumb/a.jpg","https://u@i.ytimg.com/vi/abcdefghijk/default.jpg","https://i.ytimg.com/redirect"])expect(allowedArtwork(u)).toBe(false)
  expect(()=>validTags({uploadDate:"2026-11-01"})).toThrow();expect(()=>validTags({trackNumber:0})).toThrow()
})
test("catalog enrichment abstains on ambiguous releases or a different performance",async()=>{
  const prev=globalThis.fetch
  const item={kind:"song",artistName:"Singer",trackName:"Song",trackTimeMillis:120000,collectionName:"Release"}
  try {
    let items=[item,{...item,collectionName:"Single"}]
    globalThis.fetch=Object.assign(async()=>Response.json({results:items}),{preconnect:prev.preconnect})
    const info={track:"Song",artist:"Singer",duration:120},sig=new AbortController().signal
    expect(await directoryMatch(info,sig)).toBeUndefined();items=[item];expect(await directoryMatch(info,sig)).toMatchObject({album:"Release"})
    expect(await directoryMatch({...info,title:"Song (Live)"},sig)).toBeUndefined()
  } finally {globalThis.fetch=prev}
})
