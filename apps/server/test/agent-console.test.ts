import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Credential, Integration, OpenCode } from "@opencode/sdk"
import { Plugin } from "@opencode/plugin"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { makeProviderAdmin, waitForEntry } from "../src/service/agent/provider-admin"
import { transcriber } from "../src/service/agent/voice"

// Real SDK attempt state, credential store and Console workspace import; only the device
// confirmation and remote Console response are fixtures. Never sign in to a real account.
test("Console device login: cancel, pending, workspace authorized, model selectable", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "om-console-"))
  const file = path.join(dir, "agent-config.json")
  await fs.writeFile(file, '{"agents":{"music":{"mode":"primary"}}}')
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/v1/chat/completions" && req.headers.get("authorization") === "Bearer test-access") {
      const body = await req.json() as { model:string; messages:Array<{content: Array<{type:string;input_audio?:{data:string}}> | string}> }
      const audio = body.messages.flatMap(m => typeof m.content === "string" ? [] : m.content).find(p => p.type === "input_audio")
      if (body.model !== "no-tools" || !audio?.input_audio?.data || JSON.stringify(body).includes(dir)) return new Response(null, {status:400})
      const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,channels", "-of", "csv=p=0", "pipe:0"], {stdin: Buffer.from(audio.input_audio.data,"base64")})
      if (probe.stdout.toString().trim() !== "mp3,1") return new Response(null, {status:400})
      const frame = (content:string, stop:string|null) => "data: " + JSON.stringify({ id:"test",object:"chat.completion.chunk",created:1,model:"no-tools",choices:[{index:0,delta:{role:"assistant",content},finish_reason:stop}] }) + "\n\n"
      return new Response(frame("测试听写",null)+frame("","stop")+"data: [DONE]\n\n", {headers:{"content-type":"text/event-stream"}})
    }
    if (new URL(req.url).pathname !== "/api/v2/config" || req.headers.get("authorization") !== "Bearer test-access") return new Response(null, { status: 403 })
    return Response.json({ providers: { "workspace-fixture": { name: "Fixture / Gateway", canonical: "openai", package:"@opencode/ai/providers/openai-compatible", settings:{baseURL:`${new URL(req.url).origin}/v1`},
      // Console sends capability overrides, not complete descriptors. In 2.0.8 a
      // missing input/output here discarded every provider in the workspace.
      models: { "workspace-model": { capabilities: { tools: true } },
        "no-tools": { capabilities: { tools: false, input:["audio"], output:["text"] } } } } } })
  } })
  let authorize!: () => void
  const plugin = Plugin.define({ id: "om-fixture-console", async setup(ctx) {
    await ctx.integration.transform((editor) => editor.method.update({ integrationID: "opencode",
      method: { id: "device", type: "oauth", label: "Fixture device" },
      authorize: async () => ({ mode: "auto", url: "https://opencode.ai/console/device?user_code=FIXTURE", instructions: "Enter code: FIXTURE",
        callback: new Promise((resolve) => { authorize = () => resolve(Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("device"),
          access: "test-access", refresh: "test-refresh", expires: Date.now() + 3_600_000, metadata: { server: `http://127.0.0.1:${fixture.port}`, orgName: "Fixture" } })) }),
      }),
    }))
  } })
  let host: OpenCode.Interface | undefined
  try {
    host = await OpenCode.create({ database: { path: ":memory:" }, config: { project: false, directory: dir, file }, plugins: [plugin] })
    const admin = makeProviderAdmin(host, dir, file)
    const connections = await waitForEntry(() => host!.integration.list({ location: { directory: dir } }), r => r.data.some(i => i.methods.some(m => m.type === "oauth" && m.label === "Fixture device")))
    expect(connections.data.find((i) => i.id === "opencode")?.methods.some((m) => m.type === "oauth" && m.id === "device" && m.label === "Fixture device")).toBe(true)
    const first = await Effect.runPromise(admin.consoleBegin())
    await Effect.runPromise(admin.consoleCancel(first.attemptID))
    const attempt = await Effect.runPromise(admin.consoleBegin())
    expect(attempt.instructions).toContain("FIXTURE")
    expect(await Effect.runPromise(admin.consoleStatus(attempt.attemptID))).toBe("pending")
    authorize()
    const deadline = Date.now() + 10_000
    while (await Effect.runPromise(admin.consoleStatus(attempt.attemptID)) === "pending" && Date.now() < deadline) await Bun.sleep(100)
    expect(await Effect.runPromise(admin.consoleStatus(attempt.attemptID))).toBe("complete")
    let settings = await Effect.runPromise(admin.settings())
    while (!settings.models.some((m) => m.providerID === "workspace-fixture") && Date.now() < deadline) {
      await Bun.sleep(100); settings = await Effect.runPromise(admin.settings())
    }
    expect(settings.models.some((m) => m.providerID === "workspace-fixture" && m.id === "workspace-model")).toBe(true)
    expect(settings.models.some((m) => m.providerID === "workspace-fixture" && m.id === "no-tools")).toBe(false)
    expect(JSON.stringify(settings)).not.toContain("test-access")
    expect(JSON.stringify(settings)).not.toContain("test-refresh")
    expect(settings.voiceModels.some(m => m.id === "no-tools")).toBe(true)
    await Effect.runPromise(admin.change({type:"voiceModel",providerID:"workspace-fixture",id:"no-tools"}))
    const source = Bun.spawnSync(["ffmpeg","-v","error","-f","lavfi","-i","sine=f=330:d=0.2","-c:a","libopus","-f","webm","pipe:1"])
    const invoke = () => Effect.runPromise(transcriber(host!,dir)({ mime:"audio/webm", bytes:new Uint8Array(source.stdout) }))
    // Dedicated config file is watched; never retry real inference in the application.
    expect(await waitForEntry(() => invoke().catch(() => ""), Boolean)).toBe("测试听写")
  } finally {
    await host?.close(); fixture.stop(true); await fs.rm(dir, { recursive: true, force: true })
  }
}, 25_000)
