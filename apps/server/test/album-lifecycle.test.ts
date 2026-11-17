import { expect, test } from "bun:test"
import { Pool } from "pg"
import { migrateTestDb, startServer, TestServer, TEST_DB_URL, truncateDomainTables } from "./helpers"

test("注销目录：按真实 tracks 判断、保留历史/收藏/评分、物理版本跨目录仍可见；不扫描磁盘", async () => {
  await migrateTestDb(); await truncateDomainTables(true)
  const app = await startServer(), server = new TestServer(app.handler), pool = new Pool({connectionString:TEST_DB_URL})
  try {
    await server.login()
    const insert = async (query:string, args:unknown[] = []) => String((await pool.query(query,args)).rows[0].id)
    const folder = (name:string) => insert('insert into music_folders(name,path) values ($1,$1) returning id',[name])
    const ar = await insert("insert into artists(name) values ('Fixture artist') returning id")
    const album = (name:string) => insert('insert into albums(artist_id,name) values ($1,$2) returning id',[ar,name])
    const track = (fid:string, al:string) => insert("insert into tracks(music_folder_id,album_id,artist_id,title,path,format,codec,size_bytes,mtime_ms) values ($1,$2,$3,'Title',$4,'flac','flac',0,0) returning id",[fid,al,ar,`${al}.flac`])
    const f = await folder('/fixture/one'), other = await folder('/fixture/two')
    const played = await album('Unknown Album'), starred = await album('Star'), rated = await album('Rated'),
      unused = await album('Unused'), shared = await album('Shared'), unrelated = await album('Untouched')
    const playedTrack = await track(f,played)
    for (const id of [starred,rated,unused,shared]) await track(f,id)
    const copy = await track(other,shared)
    await pool.query('update albums set track_count=999 where id=$1',[unrelated])
    expect((await server.post(`/api/v1/plays/${playedTrack}`,{})).status).toBe(204)
    expect((await server.put(`/api/v1/favorites/albums/${starred}`)).status).toBe(204)
    expect((await server.put(`/api/v1/ratings/albums/${rated}`,{rating:4})).status).toBe(204)
    const list = async (path:string) => (await server.get('/api/v1'+path)).body as {items:Array<{id:string}>;total:number}
    expect((await list('/albums')).total).toBe(5) // 5 real albums: ignore both stale zero and stale positive counts
    expect((await server.del(`/api/v1/music-folders/${f}`)).status).toBe(204)
    expect(await list('/albums')).toMatchObject({total:1,items:[{id:shared}]})
    expect(await list(`/artists/${ar}/albums`)).toMatchObject({total:1,items:[{id:shared}]})
    expect(await list('/favorites?type=album')).toMatchObject({total:0,items:[]})
    expect((await server.get('/api/v1/search?q=Unknown%20Album&type=album')).body).toMatchObject({albumCount:0,albums:[]})
    expect((await server.get(`/api/v1/tracks/${copy}`)).status).toBe(200)
    const ids = (await pool.query('select id::text from albums')).rows.map(r=>r.id)
    for(const id of [played,starred,rated,unrelated,shared]) expect(ids).toContain(id)
    expect(ids).not.toContain(unused)
    expect((await pool.query('select track_id,album_id::text from plays')).rows).toEqual([{track_id:null,album_id:played}])
    expect((await pool.query("select rating from annotations where item_type='album' and item_id=$1",[rated])).rows[0].rating).toBe(4)
    await track(other,starred)
    expect(await list('/favorites?type=album')).toMatchObject({total:1,items:[{id:starred}]})
    expect((await server.get('/api/v1/library/scan-status')).body).toMatchObject({state:'idle',lastScanAt:null})
  } finally {await pool.end();await app.dispose()}
})
