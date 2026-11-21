/**
 * The boot-time history import must be bounded and cancellable.
 *
 * The old backfill called `readSession` once per missing session; each call
 * re-listed the ENTIRE artifact tree, and its per-read race timed out without
 * aborting, so a large home pegged a core for tens of minutes with work
 * piling up behind the deadline. The replacement lists the tree once, then
 * borrows each session's own artifact through `observeSession` with a bounded
 * worker pool, and aborts the whole pass as a unit when the
 * `backfillTimeoutMs` budget runs out.
 *
 * Run: node tests/backfill.test.js
 */
import fs from 'node:fs'
import { Readable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'

const HOME = path.join(os.tmpdir(), 'dsh-bill-backfill-test')
fs.rmSync(HOME, { recursive: true, force: true })
process.env.DSH_HOME = HOME
const RECORDS_FILE = path.join(HOME, 'dsh-bill', 'records.jsonl')

const { default: plugin, Config } = await import('../lib/index.js')

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(fn, ms = 10000) {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > ms) throw new Error('timed out waiting for a condition')
    await sleep(25)
  }
}

// ── config schema ────────────────────────────────────────────────────────────
console.log('config validation')
{
  const def = Config['~standard'].validate(undefined)
  assert(def.value?.maxRecords === 20000, 'maxRecords default preserved')
  assert(def.value?.backfillTimeoutMs === 60000, 'backfillTimeoutMs defaults to 60000')
  const ok = Config['~standard'].validate({ backfillTimeoutMs: 12345 })
  assert(!ok.issues && ok.value.backfillTimeoutMs === 12345, 'backfillTimeoutMs accepted as a positive integer')
  for (const bad of [-1, 0, 1.5, 'soon', NaN]) {
    const r = Config['~standard'].validate({ backfillTimeoutMs: bad })
    assert(
      r.issues?.length === 1 && r.issues[0].path?.[0] === 'backfillTimeoutMs',
      `backfillTimeoutMs rejected: ${String(bad)}`,
    )
  }
}

// ── harness ──────────────────────────────────────────────────────────────────
/**
 * One assistant step with usage, so exactly one sample per session.
 * request/header sets a fallback model/provider; the message source overrides
 * them (the same "later report wins" logic the live path uses).
 */
const USAGE_EVENTS = [
  { type: 'request/header', seq: 0, time: 1000, data: { header: { config: { model: 'm-fallback', provider: 'p-fallback' } } } },
  {
    type: 'assistant/message', seq: 1, time: 1000,
    data: {
      turn: 0, step: 0,
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 3 },
      message: { source: { provider: 'p-src', model: 'm-src' } },
    },
  },
]

/**
 * Minimal session-query with the two methods the new backfill uses.
 * `listings` counts listing calls so a test can prove the pass ran. With
 * `hang`, `observeSession` never settles on its own — it rejects only when
 * the AbortSignal fires, mirroring the real service's observation lease;
 * `hangIds` does the same for only those sessions. `slowIds` ignore the
 * signal and resolve normally after `slowMs`, standing in for a read that was
 * already past its abort point when the budget ran out.
 */
function fakeSessionQuery(sessions, { hang = false, hangIds = [], slowIds = [], slowMs = 0, rejectIds = [] } = {}) {
  const listings = { count: 0 }
  return {
    listings,
    async listSessions(signal) {
      signal?.throwIfAborted()
      listings.count++
      return sessions.map((s) => ({ header: { id: s.id } }))
    },
    async observeSession(id, { signal } = {}) {
      signal?.throwIfAborted()
      if (hang || hangIds.includes(id)) {
        return new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted', { cause: 'abort' })), { once: true })
        })
      }
      if (slowIds.includes(id)) await sleep(slowMs)
      if (rejectIds.includes(id)) throw new Error('corrupt')
      const session = sessions.find((s) => s.id === id)
      return {
        events: session?.events ?? [],
        ...(session?.inherited === undefined ? {} : { inheritedEventCount: session.inherited }),
        [Symbol.dispose]() {},
      }
    },
  }
}

/** Boot one plugin instance against the shared temp HOME. */
function boot(config, sessionQuery) {
  let handler
  const services = { sessionQuery, webServer: { register: (route) => { handler = route.handler } } }
  const ctx = {
    ...services,
    effect: (fn) => fn(),
    get: (name) => services[name],
    on: () => {},
    inject: (names, apply) => { if (names.every((n) => services[n])) apply(ctx) },
  }
  plugin.apply(ctx, config)
  return async (body) => {
    const req = Readable.from([JSON.stringify(body)])
    let result
    await handler(req, { writeHead() {}, end(text) { result = JSON.parse(text) } })
    return result
  }
}

const readRecords = () => {
  if (!fs.existsSync(RECORDS_FILE)) return []
  return fs.readFileSync(RECORDS_FILE, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

// ── import: one pass, one listing, one record per usage sample ──────────────
console.log('history import')
{
  const sessions = [
    { id: 'sess-a', events: USAGE_EVENTS },
    { id: 'sess-b', events: USAGE_EVENTS },
    { id: 'sess-empty', events: [] },
  ]
  const sq = fakeSessionQuery(sessions)
  boot({ maxRecords: 10 }, sq)
  const records = await waitFor(() => {
    const r = readRecords()
    return r.filter((x) => x.sessionId === 'sess-a').length === 1 && r.filter((x) => x.sessionId === 'sess-b').length === 1 ? r : null
  })
  assert(sq.listings.count === 1, 'the whole pass needed exactly one artifact listing')
  const a = records.find((r) => r.sessionId === 'sess-a')
  assert(a.source === 'log', 'imported record is marked source:log')
  assert(a.model === 'm-src' && a.provider === 'p-src', 'message source wins over the header fallback')
  assert(a.inputTokens === 10 && a.outputTokens === 20, 'input/output token counts imported')
  assert(a.cacheReadTokens === 2 && a.cacheWriteTokens === 1 && a.reasoningTokens === 3, 'cache and reasoning counts imported')
  assert(!records.some((r) => r.sessionId === 'sess-empty'), 'a session with no usage imports nothing')

  // Idempotency: a second boot on the same home imports nothing new, because
  // bySession is rebuilt from the records file before backfill runs.
  const before = readRecords().length
  const sq2 = fakeSessionQuery([{ id: 'sess-a', events: USAGE_EVENTS }])
  boot({ maxRecords: 10 }, sq2)
  await waitFor(() => (sq2.listings.count >= 1 ? true : null))
  await sleep(400)
  assert(readRecords().length === before, 'second boot imports nothing (bySession covers the session)')
}

// ── inherited prefix: a forked session does not re-bill its source ───────────
// A fork's log opens with a copy of the source's events, usage and all. Those
// calls were billed to the source session; importing them again would charge
// the same money twice, which is why the import starts at the inherited cut.
console.log('inherited prefix')
{
  const own = {
    type: 'assistant/message', seq: 3, time: 2000,
    data: {
      turn: 1, step: 1,
      usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      message: { source: { provider: 'p-own', model: 'm-own' } },
    },
  }
  const fork = {
    id: 'sess-fork',
    inherited: 3,
    events: [...USAGE_EVENTS, { type: 'session/end-seed', seq: 2, time: 1000, data: { inherited: true } }, own],
  }
  boot({ maxRecords: 10 }, fakeSessionQuery([fork]))
  const records = await waitFor(() => {
    const r = readRecords().filter((x) => x.sessionId === 'sess-fork')
    return r.length > 0 ? r : null
  })
  assert(records.length === 1, `only the own usage sample is imported (got ${records.length})`)
  assert(records[0].time === 2000, 'the imported sample is the own one, not the inherited copy')
  assert(records[0].model === 'm-own', 'the inherited request/header did not leak into the record')
}

// ── per-session rejection: corrupt sessions are skipped, not fatal ───────────
console.log('per-session rejection')
{
  const sq = fakeSessionQuery(
    [{ id: 'sess-ok', events: USAGE_EVENTS }, { id: 'sess-bad', events: USAGE_EVENTS }],
    { rejectIds: ['sess-bad'] },
  )
  boot({ maxRecords: 10 }, sq)
  const records = await waitFor(() => {
    const r = readRecords()
    return r.some((x) => x.sessionId === 'sess-ok') ? r : null
  })
  assert(!records.some((r) => r.sessionId === 'sess-bad'), 'a rejected session is skipped without failing the pass')
}

// ── budget exhaustion: the pass aborts as a unit, imports nothing ────────────
console.log('budget exhaustion')
{
  const warns = []
  const realWarn = console.warn
  console.warn = (...args) => warns.push(args.join(' '))
  let sq
  try {
    sq = fakeSessionQuery([{ id: 'sess-hang', events: USAGE_EVENTS }], { hang: true })
    boot({ maxRecords: 10, backfillTimeoutMs: 150 }, sq)
    await waitFor(() => (sq.listings.count >= 1 ? true : null))
    await sleep(700)
  } finally {
    console.warn = realWarn
  }
  assert(warns.some((w) => w.includes('backfill') && w.includes('budget')), 'budget exhaustion is reported')
  assert(!readRecords().some((r) => r.sessionId === 'sess-hang'), 'nothing is imported after an abort')
}

// ── late record: a worker still mid-session at the abort is waited for ──────
// Before the pass awaited every worker, the first abort settled it while the
// slow read was still in flight; its record then landed in memory after the
// pass had already decided what to persist, and never reached the file.
console.log('late record at the budget')
{
  const warns = []
  const realWarn = console.warn
  console.warn = (...args) => warns.push(args.join(' '))
  try {
    const sq = fakeSessionQuery(
      [{ id: 'sess-hang-2', events: USAGE_EVENTS }, { id: 'sess-slow', events: USAGE_EVENTS }],
      { hangIds: ['sess-hang-2'], slowIds: ['sess-slow'], slowMs: 400 },
    )
    boot({ maxRecords: 10, backfillTimeoutMs: 150 }, sq)
    await waitFor(() => (readRecords().some((r) => r.sessionId === 'sess-slow') ? true : null), 2000).catch(() => {})
  } finally {
    console.warn = realWarn
  }
  const records = readRecords()
  assert(records.some((r) => r.sessionId === 'sess-slow'), 'a record finished after the abort is still persisted')
  assert(!records.some((r) => r.sessionId === 'sess-hang-2'), 'the aborted session imports nothing')
  assert(warns.some((w) => w.includes('backfill budget exhausted')), 'the warning carries the budget reason')
}

// ── missing observeSession: older hosts skip the import gracefully ──────────
console.log('missing observeSession')
{
  const sq = fakeSessionQuery([{ id: 'sess-a', events: USAGE_EVENTS }])
  delete sq.observeSession
  const before = readRecords().length
  boot({ maxRecords: 10 }, sq)
  // The guard returns before listing, so this must neither hang nor list.
  await sleep(500)
  assert(sq.listings.count === 0, 'a session-query without observeSession is never listed')
  assert(readRecords().length === before, 'a session-query without observeSession skips the import')
}

// A legacy compacted rollup cannot identify which sessions it already contains.
console.log('legacy archive is not replayed after reload')
{
  const dshHome = fs.mkdtempSync(path.join(HOME, 'archived-'))
  const billDir = path.join(dshHome, 'dsh-bill')
  const ringFile = path.join(billDir, 'records.jsonl')
  const rollupFile = path.join(billDir, 'rollup.json')
  const archived = { calls: 1, usd: 0.25, fileSkip: 0 }
  const active = { sessionId: 'sess-active', time: 2000, usd: 0.5 }
  fs.mkdirSync(billDir)
  fs.writeFileSync(rollupFile, JSON.stringify(archived))
  fs.writeFileSync(ringFile, JSON.stringify(active) + '\n')
  fs.utimesSync(ringFile, 1, 1)
  const sq = fakeSessionQuery([{ id: 'sess-already-archived', events: USAGE_EVENTS }])
  const ask = boot({ dshHome, maxRecords: 1 }, sq)
  // The startup rewrite means the new instance has loaded the existing store.
  await waitFor(() => fs.statSync(ringFile).mtimeMs > 1000)
  const rollup = JSON.parse(fs.readFileSync(rollupFile, 'utf8'))
  const ring = fs.readFileSync(ringFile, 'utf8').trim().split('\n').map(JSON.parse)
  assert(sq.listings.count === 0, 'history import does not list sessions when archived calls cannot be deduplicated')
  assert(rollup.calls + ring.length === 2 && rollup.usd + ring[0].usd === 0.75, 'archived and active totals survive reload without being added twice')

  const sessionId = 'sess-already-archived'
  const popup = await ask({ action: 'session-cost', sessionId })
  const report = await ask({ action: 'dashboard', sessionId, rangeDays: 0 })
  const account = await ask({ action: 'dashboard', rangeDays: 0 })
  assert(popup.calls === 1 && popup.cacheReadTokens === 2 && popup.byModel[0]?.model === 'm-src', 'the popup recovers tokens and models from the archived session log')
  assert(report.calls === 1 && report.byModel[0]?.model === 'm-src', 'the session report uses the same recovered details')
  assert(account.calls === 2 && account.totalUsd === 0.75, 'reading archived session details does not add them a second time to account totals')
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall backfill tests passed')
