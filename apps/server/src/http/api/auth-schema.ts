import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"

const del = HttpApiEndpoint.make("DELETE")
import { Schema } from "effect"
import { Conflict, Forbidden, NotFound, Unauthorized } from "../../domain/errors"
import { CreateUserRequest, LoginRequest, LoginResponse, UpdateUserRequest, UserPublic } from "../../domain/user"
import { Page } from "../../domain/media"
import { SessionAuth } from "../middleware/session"
import { SqlProvider } from "../middleware/sql"

/** 登录（开放） */
export class AuthGroup extends HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.post("login", "/auth/login", {
      payload: LoginRequest,
      success: LoginResponse,
      error: [Unauthorized],
    }),
  )
  .prefix("/api/v1") {}

/** 会话（需登录） */
export class SessionGroup extends HttpApiGroup.make("session")
  .add(
    HttpApiEndpoint.post("logout", "/auth/logout", {
      success: HttpApiSchema.NoContent,
    }),
  )
  .add(
    HttpApiEndpoint.get("me", "/auth/me", {
      success: UserPublic,
    }),
  )
  .middleware(SessionAuth).middleware(SqlProvider)
  .prefix("/api/v1") {}

/** 用户管理（需登录 + 管理员） */
export class UsersGroup extends HttpApiGroup.make("users")
  .add(
    HttpApiEndpoint.get("list", "/users", {
      query: {
        limit: Schema.optional(Schema.NumberFromString),
        offset: Schema.optional(Schema.NumberFromString),
      },
      success: Page(UserPublic),
      error: [Forbidden],
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/users", {
      payload: CreateUserRequest,
      success: UserPublic,
      error: [Conflict, Forbidden],
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/users/:id", {
      params: { id: Schema.String },
      payload: UpdateUserRequest,
      success: UserPublic,
      error: [NotFound, Forbidden],
    }),
  )
  .add(
    del("delete", "/users/:id", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden],
    }),
  )
  .middleware(SessionAuth).middleware(SqlProvider)
  .prefix("/api/v1") {}
