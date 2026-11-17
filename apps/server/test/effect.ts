/**
 * @effect/vitest 的 bun:test 移植（官方 layer()/it.effect 外壳）。
 *
 * 为什么不用 @effect/vitest 本体：服务端代码大量使用 Bun.* 运行时 API
 * （Bun.spawn/Glob/file/password/CryptoHasher），vitest 的 node 运行时跑不了；
 * 而 HttpApiTest（官方 HttpApi 测试姿势）是 effect 核心能力、与 runner 无关——
 * 只需补上「共享 Layer 构建 + it.effect」这层薄壳。
 *
 * 形态对齐 ai-docs/src/09_testing：layer(Layer)(name, (it) => { it("...", Effect) })
 */
import { afterAll, beforeAll, describe, it } from "bun:test"
import { Context, Effect, Exit, Layer, Scope } from "effect"

/** 官方 it.effect 的等价物：Effect 测试体，共享 Layer 上下文自动注入 */
export interface EffectIt {
  (name: string, effect: Effect.Effect<unknown, unknown, any>): void
}

/** 官方 layer() 的等价物：整个 describe 共享一次 Layer 构建（记忆化），afterAll 释放。
 * R 放宽为 any：rc.115 会把 group 构建期依赖泄漏成 Request 标记（类型噪声，运行时无需求） */
export const layer =
  <A>(self: Layer.Layer<A, unknown, any>) =>
  (name: string, body: (it: EffectIt) => void): void => {
    describe(name, () => {
      let context: Context.Context<A> | undefined
      let scope: Scope.Scope | undefined
      beforeAll(async () => {
        scope = Effect.runSync(Scope.make())
        context = await Effect.runPromise(Layer.buildWithScope(self as Layer.Layer<A, unknown, never>, scope))
      })
      afterAll(async () => {
        if (scope !== undefined) {
          await Effect.runPromise(Scope.close(scope, Exit.void))
        }
      })
      body((label, effect) =>
        it(label, () =>
          Effect.runPromise(
            (effect as Effect.Effect<unknown, unknown, never>).pipe(
              Effect.provide(context!),
              Effect.provideService(Scope.Scope, scope!),
            ),
          )))
    })
  }

/** 无服务依赖的独立 Effect 测试（对应裸 it.effect） */
export const effect = (name: string, self: Effect.Effect<unknown, unknown, never>) =>
  it(name, () => Effect.runPromise(self))
