import { expect,test } from 'bun:test'
import { captionCues,captionTracks } from './captions'

test('only human subtitle tracks for this exact video survive discovery',()=>{
  const id='abcdefghijk', url=`https://www.youtube.com/api/timedtext?v=${id}`
  const track=(u:string)=>[{ext:'json3',url:u}]
  const found=captionTracks({id,subtitles:{ja:track(url),asr:track(url+'&kind=asr'),fr:track(url+'&tlang=fr'),
    live_chat:track(url),other:track(url.replace(id,'lmnopqrstuv')),remote:track(url.replace('www.youtube.com','example.org'))},
    automatic_captions:{en:track(url)}},id)
  expect(found.map(t=>[t.language,t.kind])).toEqual([['ja','manual']])
  expect(captionTracks({id,automatic_captions:{ja:track(url)}},id)).toEqual([])
})

test('parse timed JSON3 without window/control events or fabricated end times',()=>{
  expect(captionCues({events:[{id:1},{tStartMs:100,segs:[{utf8:'hello '},{utf8:'world'}],dDurationMs:300},
    {tStartMs:500,segs:[{utf8:'\n'}]}, {tStartMs:800,segs:[{utf8:'次'}]}]})).toEqual([
      {startMs:100,endMs:400,text:'hello world'},{startMs:800,endMs:null,text:'次'}])
})
