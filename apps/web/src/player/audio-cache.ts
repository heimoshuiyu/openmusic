/**
 * Web 播放端音频缓存（语义对齐 apps/android 的 AudioCache）：
 * - 键 = 流请求 URL：raw 与转码回退各自一份字节，换服务器地址不串缓存
 * - Blob 落 IndexedDB：Cache Storage / Service Worker 都要求 secure context，
 *   tailnet 的 http:// 访问下不可用；IndexedDB 没有这个限制
 * - 命中 → blob URL 直接喂 <audio>，重复播放零网络；未命中 → 网络流先播，
 *   起播稳定后后台整首拉取落库（<audio> 无法边播边写，只能补一次下载）
 * - 不设硬容量上限（同 Android，用户决策）：写满配额时淘汰最旧一半再重试；
 *   队列抽屉里可手动清空
 */

const DB_NAME = "openmusic"
const DB_VERSION = 1
const STORE = "audio-cache"
const USED_AT_INDEX = "usedAt"

/** 缓存变更广播：UI 刷新统计用 */
export const AUDIO_CACHE_CHANGED = "om:audio-cache-changed"

export interface AudioCacheStats {
  entries: number
  bytes: number
}

interface CacheRow {
  url: string
  blob: Blob
  size: number
  type: string
  /** 曲目版本（createdAt + sizeBytes）：文件变化后旧条目自动作废 */
  version: string
  cachedAt: number
  usedAt: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null

const openDb = (): Promise<IDBDatabase | null> => {
  if (typeof indexedDB === "undefined") return Promise.resolve(null)
  dbPromise ??= new Promise((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "url" })
        store.createIndex(USED_AT_INDEX, "usedAt")
      }
    }
    request.onsuccess = () => {
      const db = request.result
      // 别的标签页要升级库版本时先让路，否则会 blocked
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
  return dbPromise
}

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"))
  })

const transactionDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"))
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"))
  })

const notifyChanged = (): void => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AUDIO_CACHE_CHANGED))
}

const putRow = (db: IDBDatabase, row: CacheRow): Promise<void> => {
  const tx = db.transaction(STORE, "readwrite")
  tx.objectStore(STORE).put(row)
  return transactionDone(tx)
}

const countRows = (db: IDBDatabase): Promise<number> =>
  new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).count()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(0)
    } catch {
      resolve(0)
    }
  })

/** 配额写满时淘汰 usedAt 最旧的一半（按播放使用时间，不是缓存时间） */
const evictOldest = async (db: IDBDatabase): Promise<number> => {
  const total = await countRows(db)
  if (total === 0) return 0
  const target = Math.ceil(total / 2)
  try {
    const tx = db.transaction(STORE, "readwrite")
    const store = tx.objectStore(STORE)
    let removed = 0
    const cursorRequest = store.index(USED_AT_INDEX).openCursor()
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (cursor === null || removed >= target) return
      cursor.delete()
      removed += 1
      cursor.continue()
    }
    await transactionDone(tx)
    return removed
  } catch {
    return 0
  }
}

/**
 * 读缓存。命中会把 usedAt 推到当前时间（LRU 语义），并校验曲目版本；
 * 版本不符或记录损坏时顺手删掉。任何失败都静默降级为未命中。
 */
export async function readCachedAudio(url: string, version: string): Promise<Blob | null> {
  const db = await openDb()
  if (db === null) return null
  try {
    const tx = db.transaction(STORE, "readwrite")
    const store = tx.objectStore(STORE)
    const row = (await requestResult(store.get(url))) as CacheRow | undefined
    if (row === undefined) {
      tx.abort()
      return null
    }
    if (row.version !== version) {
      store.delete(url)
      await transactionDone(tx)
      notifyChanged()
      return null
    }
    store.put({ ...row, usedAt: Date.now() })
    await transactionDone(tx)
    return row.blob instanceof Blob ? row.blob : null
  } catch {
    return null
  }
}

/**
 * 后台整首拉取并落库。signal 在切歌/清队列时取消，避免把流量浪费在
 * 用户已经跳过的曲目上。返回是否真的写入（命中 HTTP 缓存时 fetch 很快）。
 */
export async function writeCachedAudio(
  url: string,
  version: string,
  signal: AbortSignal,
): Promise<boolean> {
  const db = await openDb()
  if (db === null || signal.aborted) return false
  let blob: Blob
  try {
    const response = await fetch(url, { credentials: "same-origin", signal })
    // 只缓存完整 200；206/Range、401、0 字节（服务端转码失败的残留）都不收
    if (response.status !== 200) return false
    blob = await response.blob()
  } catch {
    return false
  }
  if (signal.aborted || blob.size === 0) return false

  const row: CacheRow = {
    url,
    blob,
    size: blob.size,
    type: blob.type || "audio/mpeg",
    version,
    cachedAt: Date.now(),
    usedAt: Date.now(),
  }
  try {
    await putRow(db, row)
  } catch {
    if (signal.aborted) return false
    await evictOldest(db)
    try {
      await putRow(db, row)
    } catch {
      return false
    }
  }
  notifyChanged()
  return true
}

/** 删除单条（缓存 blob 解码失败时回退网络用） */
export async function deleteCachedAudio(url: string): Promise<void> {
  const db = await openDb()
  if (db === null) return
  try {
    const tx = db.transaction(STORE, "readwrite")
    tx.objectStore(STORE).delete(url)
    await transactionDone(tx)
  } catch {
    /* 删除失败不影响回源播放 */
  }
  notifyChanged()
}

export async function audioCacheStats(): Promise<AudioCacheStats> {
  const db = await openDb()
  if (db === null) return { entries: 0, bytes: 0 }
  try {
    const tx = db.transaction(STORE, "readonly")
    const store = tx.objectStore(STORE)
    return await new Promise<AudioCacheStats>((resolve) => {
      let entries = 0
      let bytes = 0
      const cursorRequest = store.openCursor()
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (cursor === null) {
          resolve({ entries, bytes })
          return
        }
        entries += 1
        const size = (cursor.value as { size?: unknown }).size
        bytes += typeof size === "number" ? size : 0
        cursor.continue()
      }
      cursorRequest.onerror = () => resolve({ entries: 0, bytes: 0 })
    })
  } catch {
    return { entries: 0, bytes: 0 }
  }
}

export async function clearAudioCache(): Promise<void> {
  const db = await openDb()
  if (db === null) return
  try {
    const tx = db.transaction(STORE, "readwrite")
    tx.objectStore(STORE).clear()
    await transactionDone(tx)
  } catch {
    /* 清空失败时保持原状 */
  }
  notifyChanged()
}
