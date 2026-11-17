import {expect,test} from 'bun:test'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {Pool} from 'pg'
import {migrateTestDb,truncateDomainTables,startServer,TestServer,TEST_DB_URL} from './helpers'

test('track lyrics: sidecar/embedded precedence, durable independent bindings, edit permissions and no file writes',async()=>{
  await migrateTestDb();await truncateDomainTables(true)
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'om-lyrics-')), app=await startServer(), a=new TestServer(app.handler), b=new TestServer(app.handler)
  const pool=new Pool({connectionString:TEST_DB_URL})
  try {
    for(const name of ['studio','stage']){
      const gen=Bun.spawnSync(['ffmpeg','-v','error','-f','lavfi','-i','sine=duration=2','-metadata','title=Same title','-metadata','lyrics=Embedded verse',path.join(dir,name+'.flac')]);expect(gen.exitCode).toBe(0)
    }
    await fs.writeFile(path.join(dir,'studio.lrc'),'[00:00.50]First\n[00:01.20]Second')
    await fs.writeFile(path.join(dir,'alternate.lrc'),'Plain alternate')
    const url=(id:string)=>`/api/v1/tracks/${id}/lyrics`
    expect((await a.get(url('1'))).status).toBe(401);await a.login()
    await a.post('/api/v1/users',{username:'listener',password:'user123456',isAdmin:false});await b.login('listener','user123456')
    await a.post('/api/v1/music-folders',{name:'fixture',path:dir});await a.post('/api/v1/library/scan');await a.waitScanIdle()
    const ids=Object.fromEntries((await pool.query('select id::text,path from tracks')).rows.map(r=>[r.path,r.id as string]))
    const one=url(ids['studio.flac']!),two=url(ids['stage.flac']!)
    expect((await b.get(one)).body).toMatchObject({mode:'auto',source:'sidecar',synced:true,lines:[{text:'First',startMs:500},{text:'Second',startMs:1200}]})
    expect((await b.get(two)).body).toMatchObject({source:'embedded',synced:false,lines:[{text:'Embedded verse',startMs:null}]})
    expect((await b.put(one,{text:'not allowed'})).status).toBe(403)
    expect((await b.put(one+'/binding',{mode:'none'})).status).toBe(403)
    const edit=await a.put(one,{text:'[00:00]Shared'});expect(edit.status).toBe(200)
    const {lyricsId}=edit.body as {lyricsId:string}
    expect((await a.put(two+'/binding',{mode:'saved',lyricsId})).status).toBe(200)
    expect((await a.put(one,{text:'Private to this version'})).status).toBe(200)
    expect((await b.get(two)).body).toMatchObject({lyricsId,mode:'saved',lines:[{text:'Shared',startMs:0}]})
    expect((await a.put(one+'/binding',{mode:'file',filename:'../outside.lrc'})).status).toBe(422)
    await fs.symlink(path.join(dir,'studio.lrc'),path.join(dir,'link.lrc'))
    expect((await a.put(one+'/binding',{mode:'file',filename:'link.lrc'})).status).toBe(422)
    expect((await a.put(one+'/binding',{mode:'saved',lyricsId:'999999'})).status).toBe(404)
    expect((await b.get(one)).body).toMatchObject({source:'saved',synced:false,lines:[{text:'Private to this version'}]})
    expect((await a.put(one+'/binding',{mode:'file',filename:'alternate.lrc'})).status).toBe(200)
    expect((await b.get(one)).body).toMatchObject({source:'sidecar',filename:'alternate.lrc',lines:[{text:'Plain alternate'}]})
    await a.put(one+'/binding',{mode:'none'});expect((await b.get(one)).body).toMatchObject({mode:'none',lines:[]})
    await a.put(one+'/binding',{mode:'auto'});expect((await b.get(one)).body).toMatchObject({source:'sidecar',filename:'studio.lrc'})
    expect(await fs.readFile(path.join(dir,'studio.lrc'),'utf8')).toBe('[00:00.50]First\n[00:01.20]Second')
  } finally {await app.dispose();await pool.end();await fs.rm(dir,{recursive:true,force:true})}
},30000)
