import { open } from 'node:fs/promises'
import { ApiError } from '../middleware/errorHandler.js'

export const HISTORY_SCAN_BYTES = 4 * 1024 * 1024
export const HISTORY_RECORD_BYTES = 1024 * 1024
export const HISTORY_PAGE_BYTES = 1536 * 1024
export const HISTORY_PAGE_RECORDS = 100

type Cursor = { version: 1; dev: string; ino: string; size: number; mtime: string; offset: number; skipping: boolean }
export type HistoryPageInfo = {
  nextCursor: string | null
  hasMore: boolean
  historyComplete: boolean
  sourceVersion: string
  scannedBytes: number
  contextScanBytes?: number
  omittedOversizedEntries: number
}
export type BoundedHistoryEntry = { entry: Record<string, unknown>; byteStart: number; byteEnd: number }

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

// A fixed admission budget prevents repeated tab switches from queuing unlimited
// scans. Waiters are removed on abort, not just ignored when their scan completes.
type Waiter = { start: () => void; reject: (reason: unknown) => void; signal?: AbortSignal; abort: () => void }
const pools = {
  page: { active: 0, capacity: 2, queueCapacity: 8, waiting: [] as Waiter[] },
  context: { active: 0, capacity: 1, queueCapacity: 4, waiting: [] as Waiter[] },
  recovery: { active: 0, capacity: 1, queueCapacity: 2, waiting: [] as Waiter[] },
  metadata: { active: 0, capacity: 2, queueCapacity: 128, waiting: [] as Waiter[] },
}
async function acquire(signal: AbortSignal | undefined, lane: keyof typeof pools): Promise<() => void> {
  aborted(signal)
  const pool = pools[lane]
  if (pool.active >= pool.capacity) {
    if (pool.waiting.length >= pool.queueCapacity) throw new ApiError(429, 'History reader is busy; retry shortly', 'HISTORY_BUSY')
    await new Promise<void>((resolve, reject) => {
      const item: Waiter = { start: resolve, reject, signal, abort: () => {} }
      item.abort = () => {
        const index = pool.waiting.indexOf(item)
        if (index >= 0) pool.waiting.splice(index, 1)
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      pool.waiting.push(item)
      signal?.addEventListener('abort', item.abort, { once: true })
    })
  } else pool.active++
  return () => {
    const next = pool.waiting.shift()
    if (next) {
      next.signal?.removeEventListener('abort', next.abort)
      next.start()
    } else pool.active--
  }
}

export async function withHistoryReadBudget<T>(signal: AbortSignal | undefined, read: () => Promise<T>, lane: keyof typeof pools = 'page'): Promise<T> {
  const release = await acquire(signal, lane)
  try { aborted(signal); return await read() } finally { release() }
}

function decodeCursor(value: string): Cursor {
  try {
    if (value.length > 2048) throw new Error('long cursor')
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor
    if (cursor.version !== 1 || typeof cursor.dev !== 'string' || typeof cursor.ino !== 'string' || typeof cursor.mtime !== 'string' ||
      !Number.isSafeInteger(cursor.size) || cursor.size < 0 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > cursor.size || typeof cursor.skipping !== 'boolean') throw new Error('invalid cursor')
    return cursor
  } catch { throw ApiError.badRequest('Invalid history cursor') }
}

export async function readBoundedHistoryPage(filePath: string, options: { cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<{ entries: BoundedHistoryEntry[]; page: HistoryPageInfo }> {
  if (options.limit !== undefined && (!Number.isFinite(options.limit) || options.limit < 1)) throw new ApiError(400, 'History limit must be a positive finite number', 'INVALID_HISTORY_LIMIT')
  return withHistoryReadBudget(options.signal, async () => {
    const handle = await open(filePath, 'r')
    try {
      aborted(options.signal)
      const stat = await handle.stat({ bigint: true })
      const current = { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), mtime: String(stat.mtimeNs) }
      const cursor: Cursor = options.cursor ? decodeCursor(options.cursor) : { version: 1, ...current, offset: current.size, skipping: false }
      if (cursor.dev !== current.dev || cursor.ino !== current.ino || current.size < cursor.size || (current.size === cursor.size && current.mtime !== cursor.mtime)) {
        throw new ApiError(409, 'Session history changed; reload the newest page', 'HISTORY_CHANGED')
      }
      const sourceVersion = `${cursor.dev}:${cursor.ino}:${cursor.size}:${cursor.mtime}`
      const length = Math.min(HISTORY_SCAN_BYTES, cursor.offset)
      const start = cursor.offset - length
      const buffer = Buffer.allocUnsafe(length)
      let read = 0
      while (read < length) {
        aborted(options.signal)
        const result = await handle.read(buffer, read, length - read, start + read)
        if (!result.bytesRead) throw new ApiError(409, 'Session history changed during read', 'HISTORY_CHANGED')
        read += result.bytesRead
      }
      const limit = Math.max(1, Math.min(HISTORY_PAGE_RECORDS, Math.floor(options.limit ?? HISTORY_PAGE_RECORDS)))
      const entries: BoundedHistoryEntry[] = []
      let position = length
      let outputBytes = 0
      let skipping = cursor.skipping
      let omitted = 0
      while (position > 0 && entries.length < limit) {
        aborted(options.signal)
        const lineEnd = buffer[position - 1] === 10 ? position - 1 : position
        const newline = buffer.lastIndexOf(10, lineEnd - 1)
        const lineStart = newline + 1
        const lineLength = lineEnd - lineStart
        if (newline < 0 && start > 0) {
          // Retry a small boundary-straddling record on the next page. A record
          // spanning the whole scan budget is skipped without ever assembling it.
          if (!skipping && lineLength <= HISTORY_RECORD_BYTES && entries.length > 0) break
          if (!skipping) omitted++
          skipping = true
          position = 0
          break
        }
        if (skipping) {
          skipping = false
          position = lineStart
          continue
        }
        if (lineLength > HISTORY_RECORD_BYTES) {
          omitted++
          position = lineStart
          continue
        }
        if (lineLength && outputBytes + lineLength > HISTORY_PAGE_BYTES && entries.length) break
        position = lineStart
        if (!lineLength) continue
        try {
          const entry = JSON.parse(buffer.subarray(lineStart, lineEnd).toString('utf8'))
          if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            entries.push({ entry, byteStart: start + lineStart, byteEnd: start + lineEnd })
            outputBytes += lineLength
          }
        } catch { omitted++ }
        // Each individual parse has a byte ceiling; also yield between records
        // so a large page cannot monopolize the shared server event loop.
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      const offset = start + position
      const after = await handle.stat({ bigint: true })
      if (after.ino !== stat.ino || after.size < stat.size || (after.size === stat.size && after.mtimeNs !== stat.mtimeNs)) throw new ApiError(409, 'Session history changed during read', 'HISTORY_CHANGED')
      const nextCursor = offset > 0 ? Buffer.from(JSON.stringify({ ...cursor, offset, skipping })).toString('base64url') : null
      return {
        entries: entries.reverse(),
        page: { nextCursor, hasMore: offset > 0, historyComplete: !options.cursor && offset === 0 && omitted === 0, sourceVersion, scannedBytes: read, omittedOversizedEntries: omitted },
      }
    } finally { await handle.close() }
  })
}

/** Forward reducer source: never retain an unbounded JSONL line or source file. */
export async function streamBoundedHistory(filePath: string, onEntry: (entry: Record<string, unknown>, completeLine: boolean, byteStart: number) => void, signal?: AbortSignal, options: { startOffset?: number; endOffset?: number; onSkipped?: () => void } = {}): Promise<{ sourceVersion: string; omittedRecords: number; oversizedRecords: number; scannedBytes: number; nextOffset: number }> {
  const handle = await open(filePath, 'r')
  try {
    const stat = await handle.stat({ bigint: true })
    const size = Math.min(Number(stat.size), options.endOffset ?? Number(stat.size))
    const firstOffset = options.startOffset ?? 0
    let lineStart = firstOffset
    let nextOffset = firstOffset
    const chunk = Buffer.allocUnsafe(64 * 1024)
    let parts: Buffer[] = []
    let length = 0
    let skipping = false
    let omittedRecords = 0
    let oversizedRecords = 0
    const flush = (completeLine = true) => {
      if (skipping) { omittedRecords++; oversizedRecords++; options.onSkipped?.() }
      else if (length) {
        let entry: unknown
        try {
          entry = JSON.parse((parts.length === 1 ? parts[0]! : Buffer.concat(parts, length)).toString('utf8'))
        } catch { omittedRecords++; options.onSkipped?.() }
        // Consumer failures (limits, cancellation, I/O) must propagate. They
        // are not malformed JSON and must never become a successful snapshot.
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) onEntry(entry as Record<string, unknown>, completeLine, lineStart)
      }
      parts = []; length = 0; skipping = false
    }
    for (let offset = firstOffset; offset < size;) {
      aborted(signal)
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - offset), offset)
      if (!bytesRead) throw new ApiError(409, 'Session history changed during recovery', 'HISTORY_CHANGED')
      offset += bytesRead
      let start = 0
      while (start < bytesRead) {
        aborted(signal)
        const found = chunk.indexOf(10, start)
        const end = found >= 0 && found < bytesRead ? found : bytesRead
        if (!skipping) {
          length += end - start
          if (length > HISTORY_RECORD_BYTES) { skipping = true; parts = [] }
          else parts.push(Buffer.from(chunk.subarray(start, end)))
        }
        start = end + 1
        if (end < bytesRead) {
          flush()
          lineStart = offset - bytesRead + end + 1
          nextOffset = lineStart
          await new Promise<void>(resolve => setImmediate(resolve))
        }
      }
    }
    if (length || skipping) flush(false)
    const after = await handle.stat({ bigint: true })
    if (after.size < stat.size || (after.size === stat.size && after.mtimeNs !== stat.mtimeNs)) throw new ApiError(409, 'Session changed during recovery; retry', 'HISTORY_CHANGED')
    return { sourceVersion: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`, omittedRecords, oversizedRecords, scannedBytes: size - firstOffset, nextOffset }
  } finally { await handle.close() }
}
