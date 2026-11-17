import { nativeEvents, rpc, tell } from "./bridge"

export function openAgentEvents(open:()=>void, data:(s:string)=>void) {
  const message=(e:Event)=>data((e as CustomEvent<string>).detail)
  nativeEvents.addEventListener("open",open);nativeEvents.addEventListener("event",message);tell("subscribe")
  return ()=>{nativeEvents.removeEventListener("open",open);nativeEvents.removeEventListener("event",message);tell("unsubscribe")}
}
export async function playConfirmedTracks(kind:"play-now"|"enqueue",ids:string[],current:()=>boolean) {
  if(current() && (await rpc("play",{kind,ids})).status!==204)throw new Error("播放失败")
}
