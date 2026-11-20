import { Effect } from "effect"

/**
 * 密码与 Subsonic 兼容凭据工具。
 *
 * - argon2 哈希用于第一方登录（Bun.password）
 * - Subsonic token 认证需要可逆地取回明文密码（token = md5(password + salt)，
 *   无法从任何哈希推导）——与 Navidrome 相同的做法：AES-256-GCM 加密存储，
 *   密钥来自 OPENMUSIC_SECRET 环境变量，缺省时首启生成并落盘 DATA_DIR/secret.key
 *   （见 docs/03 §2.7 的实现修订）
 */

const subtle = () => globalThis.crypto.subtle

const importKey = (raw: Uint8Array): Promise<CryptoKey> =>
  subtle().importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"])

export const sha256Hex = (input: string): string =>
  new Bun.CryptoHasher("sha256").update(input).digest("hex")

export const md5Hex = (input: string): string =>
  new Bun.CryptoHasher("md5").update(input).digest("hex")

export const randomToken = (bytes = 32): string =>
  Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes))).toString("hex")

/** AES-256-GCM 加密，输出 base64(nonce(12) + ciphertext) */
export const encryptSecret = (key: Uint8Array, plaintext: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const cryptoKey = await importKey(key)
    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12))
    const data = new TextEncoder().encode(plaintext)
    const cipher = await subtle().encrypt({ name: "AES-GCM", iv: nonce }, cryptoKey, data)
    const out = new Uint8Array(nonce.length + cipher.byteLength)
    out.set(nonce)
    out.set(new Uint8Array(cipher), nonce.length)
    return Buffer.from(out).toString("base64")
  })

export const decryptSecret = (key: Uint8Array, encoded: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const raw = Buffer.from(encoded, "base64")
    const nonce = raw.subarray(0, 12)
    const cipher = raw.subarray(12)
    const cryptoKey = await importKey(key)
    const plain = await subtle().decrypt({ name: "AES-GCM", iv: nonce }, cryptoKey, cipher)
    return new TextDecoder().decode(plain)
  })

/** 从 Buffer 构造 key bytes */
export const keyFromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"))

export const hashPassword = (password: string): Effect.Effect<string> =>
  Effect.promise(() => Bun.password.hash(password))

export const verifyPassword = (password: string, hash: string): Effect.Effect<boolean> =>
  Effect.promise(() => Bun.password.verify(password, hash))
