import {expect,test} from 'bun:test'
import {parseLyrics} from './lyrics'

test('LRC normalizes repeated times, offsets and translations without guessing time for plain lyrics',()=>{
  expect(parseLyrics('\uFEFF[ar:fixture]\r\n[00:03.5][00:01.050]副歌\n[00:03.500]Chorus\n[offset:+50]')).toEqual([
    {startMs:1000,text:'副歌'},{startMs:3450,text:'副歌\nChorus'}])
  expect(parseLyrics('First\nSecond')).toEqual([{startMs:null,text:'First'},{startMs:null,text:'Second'}])
  expect(()=>parseLyrics('[00:01]'.repeat(5000)+'x')).toThrow()
})
