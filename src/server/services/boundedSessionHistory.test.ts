import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile, appendFile, open, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBoundedHistoryPage, streamBoundedHistory, withHistoryReadBudget, HISTORY_SCAN_BYTES, HISTORY_RECORD_BYTES } from './boundedSessionHistory.js'

let directory: string
let file: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'history-budget-test-')); file = join(directory, 'session.jsonl') })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
const row = (id: string, text = id) => JSON.stringify({ type: 'assistant', uuid: id, message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'

describe('bounded history pages', () => {
  test('reads a bounded tail and pages every ordinary large record without loss', async () => {
    const handle = await open(file, 'w')
    for (let index = 0; index < 60; index++) await handle.write(row(String(index), 'x'.repeat(256 * 1024)))
    await handle.close()
    let cursor: string | undefined
    const ids: string[] = []
    do {
      const result = await readBoundedHistoryPage(file, { cursor })
      expect(result.page.scannedBytes).toBeLessThanOrEqual(HISTORY_SCAN_BYTES)
      expect(result.page.omittedOversizedEntries).toBe(0)
      expect(result.entries.length).toBeGreaterThan(0)
      ids.unshift(...result.entries.map(item => item.entry.uuid as string))
      cursor = result.page.nextCursor ?? undefined
    } while (cursor)
    expect(ids).toEqual(Array.from({ length: 60 }, (_, index) => String(index)))
  })

  test('skips giant lines across bounded windows and preserves both neighboring messages', async () => {
    await writeFile(file, row('before'))
    const handle = await open(file, 'a')
    await handle.write('{"message":"')
    for (let index = 0; index < 12; index++) await handle.write('x'.repeat(1024 * 1024))
    await handle.write('"}\n' + row('after'))
    await handle.close()
    let cursor: string | undefined
    const ids: string[] = []
    let omissions = 0
    let requests = 0
    do {
      const result = await readBoundedHistoryPage(file, { cursor })
      expect(result.page.scannedBytes).toBeLessThanOrEqual(HISTORY_SCAN_BYTES)
      omissions += result.page.omittedOversizedEntries
      ids.unshift(...result.entries.map(item => item.entry.uuid as string))
      cursor = result.page.nextCursor ?? undefined
      requests++
      expect(requests).toBeLessThan(8)
    } while (cursor)
    expect(ids).toEqual(['before', 'after'])
    expect(omissions).toBe(1)
  })

  test('snapshot cursors tolerate appends but reject replacement and malformed cursors', async () => {
    await writeFile(file, row('a') + row('b'))
    const first = await readBoundedHistoryPage(file, { limit: 1 })
    await appendFile(file, row('c'))
    const second = await readBoundedHistoryPage(file, { cursor: first.page.nextCursor! })
    expect(second.entries.map(item => item.entry.uuid)).toEqual(['a'])
    await writeFile(`${file}.new`, row('replacement'))
    await rename(`${file}.new`, file)
    await expect(readBoundedHistoryPage(file, { cursor: first.page.nextCursor! })).rejects.toMatchObject({ statusCode: 409 })
    await expect(readBoundedHistoryPage(file, { cursor: 'garbage' })).rejects.toThrow('Invalid history cursor')
  })

  test('forward recovery bounds single records, parses surrounding evidence, and aborts promptly', async () => {
    await writeFile(file, row('a') + row('too-large', 'x'.repeat(HISTORY_RECORD_BYTES + 100)) + row('b'))
    const ids: unknown[] = []
    const result = await streamBoundedHistory(file, entry => ids.push(entry.uuid))
    expect(ids).toEqual(['a', 'b'])
    expect(result.omittedRecords).toBe(1)
    const controller = new AbortController()
    let visits = 0
    await expect(streamBoundedHistory(file, () => { visits++; controller.abort() }, controller.signal)).rejects.toThrow()
    expect(visits).toBe(1)
  })

  test('rejects queue overflow and removes aborted waiters without starving later reads', async () => {
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const active = [withHistoryReadBudget(undefined, () => hold), withHistoryReadBudget(undefined, () => hold)]
    const controller = new AbortController()
    const cancelled = withHistoryReadBudget(controller.signal, async () => 'unreachable').catch(error => error)
    const queued = Array.from({ length: 7 }, () => withHistoryReadBudget(undefined, async () => 'ok'))
    await expect(withHistoryReadBudget(undefined, async () => 'overflow')).rejects.toMatchObject({ statusCode: 429 })
    controller.abort()
    await cancelled
    const replacement = withHistoryReadBudget(undefined, async () => 'replacement')
    release()
    await Promise.all(active)
    expect(await Promise.all(queued)).toEqual(Array(7).fill('ok'))
    expect(await replacement).toBe('replacement')
  })
})
