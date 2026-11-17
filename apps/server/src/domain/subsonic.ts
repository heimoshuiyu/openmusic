import { Effect } from "effect"

/**
 * Subsonic 响应模型：单一 Node 结构同时渲染 JSON（f=json）与 XML。
 *
 * - attrs 里的标量 → JSON 字段 / XML 属性（Subsonic 惯例：标量作属性）
 * - children 为显式数组（同名标签重复），JSON 中保持数组
 * - XML 为尽力而为（Feishin 只用 JSON；见 docs/05 §4）
 */
/** children 的值：数组 = JSON 数组（列表字段）；单个 SNode = JSON 对象（包裹节点） */
export type SChild = ReadonlyArray<SNode> | SNode

export interface SNode {
  readonly tag: string
  readonly attrs: Readonly<Record<string, string | number | boolean | undefined>>
  readonly text?: string
  readonly children?: Readonly<Record<string, SChild>>
}

export const node = (
  tag: string,
  attrs: SNode["attrs"] = {},
  children?: SNode["children"],
): SNode => (children === undefined ? { tag, attrs } : { tag, attrs, children })

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

const xmlAttr = (value: string | number | boolean): string =>
  typeof value === "boolean" ? String(value) : typeof value === "number" ? String(value) : escapeXml(value)

const renderXmlNode = (node: SNode): string => {
  const attrs = Object.entries(node.attrs)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ` ${key}="${xmlAttr(value as string | number | boolean)}"`)
    .join("")
  const childNodes = node.children
    ? Object.values(node.children).flatMap((child) =>
      "tag" in child ? [renderXmlNode(child)] : child.map(renderXmlNode))
    : []
  const inner = [...(node.text !== undefined ? [escapeXml(node.text)] : []), ...childNodes].join("")
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`
}

const renderJsonNode = (node: SNode): unknown => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node.attrs)) {
    if (value !== undefined && value !== null) out[key] = value
  }
  if (node.text !== undefined) out.value = node.text
  if (node.children !== undefined) {
    for (const [key, child] of Object.entries(node.children)) {
      if ("tag" in child) {
        out[key] = renderJsonNode(child)
      } else if (child.length > 0) {
        out[key] = child.map(renderJsonNode)
      }
    }
  }
  return out
}

/** Subsonic 标准错误码（docs/05 §4） */
export const SUBSONIC_ERRORS = {
  generic: 0,
  missingParameter: 10,
  wrongUsernameOrPassword: 40,
  notAuthorized: 50,
  requestedDataNotFound: 70,
} as const

export interface SubsonicEnvelope {
  readonly status: "ok" | "failed"
  readonly version: string
  readonly serverVersion: string
  readonly openSubsonic: boolean
  readonly error?: { readonly code: number; readonly message: string }
  readonly children?: Readonly<Record<string, SChild>>
}

/** 构造响应（HttpServerResponse.json/text 由调用方包） */
export const envelope = {
  ok: (children?: SNode["children"]): SubsonicEnvelope =>
    children === undefined
      ? { status: "ok", version: SUBSONIC_VERSION, serverVersion: SERVER_VERSION, openSubsonic: true }
      : {
        status: "ok",
        version: SUBSONIC_VERSION,
        serverVersion: SERVER_VERSION,
        openSubsonic: true,
        children,
      },
  error: (code: number, message: string): SubsonicEnvelope => ({
    status: "failed",
    version: SUBSONIC_VERSION,
    serverVersion: SERVER_VERSION,
    openSubsonic: true,
    error: { code, message },
  }),
}

// 延迟绑定常量（避免循环导入 shared）
import { SERVER_VERSION, SUBSONIC_API_VERSION as SUBSONIC_VERSION } from "@openmusic/shared"

export const renderSubsonic = (
  envelope: SubsonicEnvelope,
  format: string | undefined,
): { readonly body: string; readonly contentType: string } => {
  if (format === "xml") {
    const attrs = [
      `xmlns="http://subsonic.org/restapi"`,
      `status="${envelope.status}"`,
      `version="${envelope.version}"`,
      `serverVersion="${envelope.serverVersion}"`,
      `openSubsonic="${envelope.openSubsonic}"`,
    ].join(" ")
    const inner = envelope.error !== undefined
      ? `<error code="${envelope.error.code}" message="${escapeXml(envelope.error.message)}"/>`
      : Object.values(envelope.children ?? {})
          .flatMap((child) => ("tag" in child ? [renderXmlNode(child)] : child.map(renderXmlNode)))
          .join("")
    return { body: `<?xml version="1.0" encoding="UTF-8"?><subsonic-response ${attrs}>${inner}</subsonic-response>`, contentType: "text/xml; charset=utf-8" }
  }
  const payload: Record<string, unknown> = {
    status: envelope.status,
    version: envelope.version,
    serverVersion: envelope.serverVersion,
    openSubsonic: envelope.openSubsonic,
  }
  if (envelope.error !== undefined) payload.error = envelope.error
  for (const [key, child] of Object.entries(envelope.children ?? {})) {
    if ("tag" in child) {
      payload[key] = renderJsonNode(child)
    } else if (child.length > 0) {
      payload[key] = child.map(renderJsonNode)
    }
  }
  return { body: JSON.stringify({ "subsonic-response": payload }), contentType: "application/json" }
}

/** 从 query/form 参数解析 Subsonic 认证四元组 */
export interface SubsonicAuthParams {
  readonly username: string
  readonly token?: string
  readonly salt?: string
  readonly password?: string
}

export const subsonicResponse = (envelope: SubsonicEnvelope, format: string | undefined) =>
  Effect.sync(() => {
    const rendered = renderSubsonic(envelope, format)
    return new Response(rendered.body, {
      status: 200,
      headers: { "content-type": rendered.contentType },
    })
  })
