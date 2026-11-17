import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"

export class SystemHealth extends Schema.Class<SystemHealth>("SystemHealth")({
  status: Schema.Literal("ok"),
  version: Schema.String,
  db: Schema.Literal("ok"),
}) {}

export class SystemVersionInfo extends Schema.Class<SystemVersionInfo>("SystemVersionInfo")({
  name: Schema.String,
  version: Schema.String,
}) {}

export class SystemGroup extends HttpApiGroup.make("system")
  .add(HttpApiEndpoint.get("health", "/system/health", { success: SystemHealth }))
  .add(HttpApiEndpoint.get("version", "/system/version", { success: SystemVersionInfo }))
  .prefix("/api/v1") {}
