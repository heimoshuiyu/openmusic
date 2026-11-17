import { create } from "zustand"
import type { PendingQuestion } from '@openmusic/shared/agent-parts'
import { api, type AgentDelivery, type AgentEventDto, type AgentSessionDto, type InboxItem } from "@/api/client"
import { openAgentEvents, playConfirmedTracks } from "@/agent/platform"
import { applyEvent, historyEntries, mergeHistory, type Thread } from "./timeline"

interface AgentStore extends Thread {
  open: boolean
  sessions: readonly AgentSessionDto[]
  activeId: string | null
  loading: boolean
  sending: boolean
  pending: readonly InboxItem[]
  questions: readonly PendingQuestion[]
  error: string | null
  drafts: ReadonlyMap<string, string>
  setDraft: (session: string, text: string) => void
  setPageActive: (active: boolean) => void
  ensureConnected: () => void
  reset: () => void
  refreshSessions: () => Promise<void>
  select: (id: string) => Promise<void>
  newSession: () => Promise<string | null>
  refreshThread: (includeHistory?: boolean) => Promise<void>
  send: (text: string, delivery?:AgentDelivery) => Promise<boolean>
  changePending: (id:string, delivery:AgentDelivery|null) => Promise<void>
  settleQuestion: (session:string,id:string,answers:string[][]|null) => Promise<void>
  interrupt: () => Promise<void>
  acceptPending: (id: string) => Promise<void>
  dismissPending: (id: string) => void
}

let closeEvents: (() => void) | null = null
let generation = 0 // auth boundary; ignore unfinished work from the previous login
let selection = 0
let snapshot = 0
let historyRead = 0
let executionRevision = 0
let sequence = 0
let listUpdates: Map<string, string> | null = null
const localId = () => `local:${++sequence}`

export const useAgentStore = create<AgentStore>((set, get) => ({
  open: false,
  sessions: [],
  activeId: null,
  entries: [],
  busy: false,
  loading: false,
  sending:false, pending:[], questions:[],
  error: null,
  drafts: new Map(),
  setDraft: (session, text) => set(s => {
    const drafts = new Map(s.drafts)
    if (text) drafts.set(session, text); else drafts.delete(session)
    return {drafts}
  }),

  reset: () => {
    generation++
    selection++
    listUpdates = null
    closeEvents?.()
    closeEvents = null
    set({ open: false, sessions: [], activeId: null, entries: [], pending:[], questions:[], drafts:new Map(), sending:false, busy: false, loading: false, error: null })
  },

  setPageActive: (open) => {
    set({ open })
    if (open) get().ensureConnected()
  },

  ensureConnected: () => {
    if (closeEvents !== null) return
    const auth = generation
    closeEvents = openAgentEvents(() => {
      if(auth!==generation)return
      if(get().activeId){ void get().refreshSessions(); void get().refreshThread() }
    }, message => {
      if (auth !== generation) return
      try {
        const event = JSON.parse(message) as AgentEventDto
        if(event.type === 'questions.changed') {
          if(event.sessionID === get().activeId) void get().refreshThread()
          return
        }
        if(event.type === "inbox.changed") {
          if(event.sessionID === get().activeId) void get().refreshThread(event.delivered)
          return
        }
        if (event.type === "session.renamed") {
          listUpdates?.set(event.sessionID, event.title)
          set((s) => ({ sessions: s.sessions.map((session) => session.id === event.sessionID ? { ...session, title: event.title } : session) }))
          return
        }
        if (event.type === "raw" && (event.event.data as {sessionID?:string}|undefined)?.sessionID === get().activeId && event.event.type.startsWith("session.execution.")) {
          executionRevision++
          if (event.event.type !== 'session.execution.started' && get().entries.some(e=>e.type==='tool' && e.name==='question')) void get().refreshThread()
        }
        set((s) => applyEvent(s, s.activeId, event, localId))
      } catch {
        /* 非 JSON 帧忽略 */
      }
    })
    // A broken SSE connection doesn't mean the host stopped. onopen reconciles the inbox and history.
  },

  refreshSessions: async () => {
    // A rename can overtake GET, including for a session not yet in the local list.
    const updates = listUpdates = new Map<string, string>()
    try {
      const sessions = await api.agentSessions()
      if (listUpdates === updates) set({ sessions: sessions.map((s) => ({ ...s, title: updates.get(s.id) ?? s.title })), error: null })
    } catch (error) {
      if (listUpdates === updates) set({ error: error instanceof Error ? error.message : "会话列表读取失败" })
    } finally {
      if (listUpdates === updates) listUpdates = null
    }
  },

  select: async (id) => {
    if (id === get().activeId && !get().error) return
    ++selection
    set({ activeId: id, entries: [], pending:[], questions:[], sending:false, busy: false, loading: true, error: null })
    await get().refreshThread()
  },

  refreshThread: async (includeHistory = true) => {
    const id=get().activeId, request=selection, read=++snapshot, revision=executionRevision
    if(!id)return
    const history=includeHistory || get().loading ? ++historyRead : undefined
    const current=()=>request===selection && get().activeId===id
    try {
      const [messages,inbox]=await Promise.all([history ? api.agentMessages(id) : undefined,api.agentInbox(id)])
      if(current())set(s=>{
        const entries = messages && history===historyRead ? mergeHistory(historyEntries(messages),s.entries) : s.entries
        const deliveredIds = new Set(entries.filter(e=>e.type==="user").map(e=>e.id))
         return {entries, questions:read===snapshot ? inbox.questions??[] : s.questions, pending:(read===snapshot ? inbox.items : s.pending).filter(i=>!deliveredIds.has(i.id)),
          ...(read===snapshot && revision===executionRevision && {busy:inbox.busy}), ...(history===historyRead && {loading:false})}
      })
    } catch (error) {
      if (current() && read===snapshot) set({ loading: false, error: error instanceof Error ? error.message : "会话读取失败" })
    }
  },

  newSession: async () => {
    const auth = generation
    const request = selection // Route selection changes only after creation succeeds.
    try {
      const session = await api.agentSessionCreate()
      if (auth !== generation) return null
      listUpdates = null // Don't let an older session-list response hide the new row.
      set((s) => ({ sessions: [session, ...s.sessions.filter(other=>other.id!==session.id)] }))
      return request === selection ? session.id : null
    } catch (error) {
      if (request === selection) set({ loading: false, error: error instanceof Error ? error.message : "会话创建失败" })
      return null
    }
  },

  send: async (text, delivery="steer") => {
    const request=selection
    const { activeId, sending, loading } = get()
    if (!activeId || sending || loading || !text.trim()) return false
    const auth = generation, draft = get().drafts.get(activeId)
    set({sending:true,error:null})
    try {
      await api.agentPrompt(activeId, text, delivery)
      if (auth === generation && draft?.trim() === text && get().drafts.get(activeId) === draft) get().setDraft(activeId, "")
      if (request!==selection) return false
      void get().refreshThread()
      return true
    } catch (error) {
      if (request===selection) set({error: error instanceof Error ? error.message : "发送失败"})
      return false
    } finally {if(request===selection)set({sending:false})}
  },

  settleQuestion: async (session,id,answers) => {
    const request=selection
    if(get().activeId!==session || !get().questions.some(q=>q.id===id))return
    try {
      await api.agentSettleQuestion(session,id,answers)
      if(request===selection)set(s=>({questions:s.questions.filter(q=>q.id!==id),error:null}))
    } catch(e) { if(request===selection)set({error:e instanceof Error?e.message:'问题状态已变化，请重试'}) }
    finally {if(request===selection)await get().refreshThread()}
  },

  changePending: async (id,delivery) => {
    const request=selection, session=get().activeId
    if(!session)return
    try {await api.agentChangePending(session,id,delivery)}
    catch(e){if(request===selection)set({error:e instanceof Error ? e.message : "待投递消息已变化"})}
    finally {if(request===selection)void get().refreshThread()}
  },

  interrupt: async () => {
    const auth = generation
    const { activeId } = get()
    if (!activeId) return
    try {
      await api.agentInterrupt(activeId)
      if (auth === generation && get().activeId === activeId) void get().refreshThread()
    } catch {
      /* 打断失败仍可等待流结束 */
    }
  },

  acceptPending: async (id) => {
    const auth = generation
    const entry = get().entries.find((item) => item.id === id)
    if (entry?.type !== "action") return
    get().dismissPending(id)
    try {
      await playConfirmedTracks(entry.action.kind, entry.action.tracks.map(t => t.id), () => auth === generation)
    } catch {
      if (auth === generation) set({error:"未能把曲目交给播放器。"})
    }
  },
  dismissPending: (id) => set((s) => ({ entries: s.entries.filter((entry) => entry.id !== id) })),
}))
