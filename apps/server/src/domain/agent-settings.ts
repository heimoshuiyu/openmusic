import { Schema } from "effect"

const short = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(256)))
export const ModelRef = Schema.Struct({ providerID: short, id: short })
export const AgentSettings = Schema.Struct({
  current: Schema.NullOr(ModelRef),
  voiceModel: Schema.String,
  voiceModels: Schema.Array(Schema.Struct({ ...ModelRef.fields, name: Schema.String, provider: Schema.String })),
  models: Schema.Array(Schema.Struct({ ...ModelRef.fields, name: Schema.String, provider: Schema.String })),
  integrations: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, key: Schema.Boolean,
    consoleLogin: Schema.Boolean, connected: Schema.Boolean,
    accounts: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  })),
})
export const SettingsChange = Schema.Union([
  Schema.Struct({ type: Schema.Literal("model"), ...ModelRef.fields }),
  Schema.Struct({ type: Schema.Literal("voiceModel"), ...ModelRef.fields }),
  Schema.Struct({ type: Schema.Literal("key"), integrationID: short, key: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(8192))) }),
  Schema.Struct({ type: Schema.Literals(["activate", "disconnect"]), integrationID: short, credentialID: short }),
  Schema.Struct({ type: Schema.Literal("custom"), slug: short, name: short, baseURL: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(2048))),
    models: Schema.Array(short).pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(32))) }),
])
export const ConsoleAttempt = Schema.Struct({ attemptID: Schema.String, url: Schema.String, instructions: Schema.String, expires: Schema.Number })
export const ConsoleStatus = Schema.Literals(["pending", "complete", "failed", "expired"])
