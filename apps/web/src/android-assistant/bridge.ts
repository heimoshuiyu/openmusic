// Transferred by WebView.postWebMessage to the exact APK asset origin. No cookies,
// arbitrary URL fetch, JS evaluation, or device-wide JavascriptInterface.
let port: MessagePort
let next = 0
type Reply = {id:number; status:number; body:string}
const pending = new Map<number, (reply:Reply)=>void>()
export const nativeEvents = new EventTarget()

export function connect(start: () => void, channel = "openmusic-assistant") {
  window.addEventListener("message", function handshake(event) {
    if (event.data !== channel || !event.ports[0]) return
    window.removeEventListener("message", handshake)
    port = event.ports[0]
    port.onmessage = e => {
      const msg = JSON.parse(e.data)
      if (msg.id !== undefined) { pending.get(msg.id)?.(msg); return }
      nativeEvents.dispatchEvent(new CustomEvent(msg.type,{detail:msg.data}))
    }
    start(); tell("ready")
  })
}
export function tell(op:string, extra:Record<string,unknown> = {}) { port.postMessage(JSON.stringify({op,...extra})) }
export function rpc(op:string, args:Record<string,unknown>, signal?:AbortSignal|null):Promise<Reply> {
  return new Promise((resolve,reject) => {
    const id=++next
    const abort = () => { pending.delete(id); tell("cancel",{id}); reject(new DOMException("已取消","AbortError")) }
    if(signal?.aborted){reject(new DOMException("已取消","AbortError"));return}
    signal?.addEventListener("abort",abort,{once:true})
    pending.set(id,reply=>{ pending.delete(id); signal?.removeEventListener("abort",abort); resolve(reply) })
    tell(op,{...args,id})
  })
}
export const apiFetch: typeof fetch = async (input, init) => {
  if(typeof input !== "string") throw new Error("不支持的请求")
  let body = init?.body, mime = "application/json"
  if(body instanceof Blob){
    const blob=body; mime=blob.type
    body=await new Promise<string>((resolve,reject)=>{const r=new FileReader(); r.onload=()=>resolve(String(r.result).split(",")[1]!);r.onerror=()=>reject(new Error("无法读取录音"));r.readAsDataURL(blob)})
  }
  const r = await rpc("request",{path:input,method:init?.method ?? "GET",body:body ?? "",mime},init?.signal)
  return new Response(r.status===204 ? null : r.body,{status:r.status})
}
