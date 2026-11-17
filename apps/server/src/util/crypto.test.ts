import { describe, expect } from "bun:test"
import { Effect } from "effect"
import {
  decryptSecret,
  encryptSecret,
  keyFromHex,
  md5Hex,
  randomToken,
  sha256Hex,
} from "./crypto"
import { effect } from "../../test/effect"

const KEY = keyFromHex("aa".repeat(32))

describe("crypto 工具", () => {
  effect("md5/sha256 已知向量", Effect.sync(() => {
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72")
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
  }))

  effect("AES-256-GCM 加解密往返（含中日文）", Effect.gen(function* () {
    const plaintext = "パスワード fixture 🔐"
    const encrypted = yield* encryptSecret(KEY, plaintext)
    expect(encrypted).not.toContain(plaintext)
    expect(yield* decryptSecret(KEY, encrypted)).toBe(plaintext)
  }))

  effect("错误密钥解密失败", Effect.gen(function* () {
    const encrypted = yield* encryptSecret(KEY, "secret")
    const wrongKey = keyFromHex("bb".repeat(32))
    const result = yield* Effect.exit(decryptSecret(wrongKey, encrypted))
    expect(result._tag).toBe("Failure")
  }))

  effect("相同明文每次密文不同（随机 nonce）", Effect.gen(function* () {
    const first = yield* encryptSecret(KEY, "same")
    const second = yield* encryptSecret(KEY, "same")
    expect(first).not.toBe(second)
  }))

  effect("randomToken 长度与 hex 字符集", Effect.sync(() => {
    const token = randomToken(32)
    expect(token).toHaveLength(64)
    expect(token).toMatch(/^[0-9a-f]+$/)
    expect(randomToken(8)).not.toBe(randomToken(8))
  }))

  effect("keyFromHex 往返", Effect.sync(() => {
    const hex = "0123abcd".repeat(8)
    expect(Buffer.from(keyFromHex(hex)).toString("hex")).toBe(hex)
  }))
})
