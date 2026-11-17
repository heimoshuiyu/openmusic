import { Schema } from "effect"
import { Id, Timestamp } from "./media"

export class UserPublic extends Schema.Class<UserPublic>("UserPublic")({
  id: Id,
  username: Schema.String,
  isAdmin: Schema.Boolean,
  createdAt: Timestamp,
  lastSeenAt: Schema.optional(Schema.NullOr(Timestamp)),
}) {}

export const LoginRequest = Schema.Struct({
  username: Schema.NonEmptyString,
  password: Schema.NonEmptyString,
})

export class LoginResponse extends Schema.Class<LoginResponse>("LoginResponse")({
  user: UserPublic,
  expiresAt: Timestamp,
}) {}

export const CreateUserRequest = Schema.Struct({
  username: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
  password: Schema.String.pipe(Schema.check(Schema.isMinLength(6))),
  isAdmin: Schema.optional(Schema.Boolean),
})

export const UpdateUserRequest = Schema.Struct({
  password: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMinLength(6)))),
  isAdmin: Schema.optional(Schema.Boolean),
})
