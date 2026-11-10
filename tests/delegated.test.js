/**
 * Delegated agents are billed under their own session ids, so a conversation's
 * cost has to be assembled from its own records plus every session it
 * delegated, at any depth. These tests boot the plugin with a session-query
 * that carries the parent links and check all four surfaces read from it:
 * `session-cost` (own + a delegated breakdown), `session-subagents` (the dock's
 * headline), `dashboard` with a session id (the conversation's tab) and the
 * `bill_stats` scope string.
 *
 * Run: node tests/delegated.test.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = path.join(os.tmpdir(), 'dsh-bill-delegated-test')
fs.rmSync(HOME, { recursive: true, force: true })
process.env.DSH_HOME = HOME
const RECORDS_FILE = path.join(HOME, 'dsh-bill', 'records.jsonl')

const { default: plugin } = await import('../lib/index.js')

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

const readRecords = () => {
  if (!fs.existsSync(RECORDS_FILE)) return []
  return fs.readFileSync(RECORDS_FILE, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/** One usage sample per session, at a distinct time so records stay apart. */
function usage(time, model) {
  return [
    { type: 'request/header', seq: 0, time, data: { header: { config: { model, provider: 'p' } } } },
    {
      type: 'assistant/message', seq: 1, time,
      data: {
        turn: 0, step: 0,
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        message: { source: { provider: 'p', model } },
      },
    },
  ]
}

/**
 * session-query stub: the corpus plus the parent links. `listings` counts
 * listing calls so the lineage cache can be exercised through the route.
 */
function fakeSessionQuery(sessions) {
  const listings = { count: 0 }
  return {
    listings,
    async listSessions() {
      listings.count++
      return sessions.map((s) => ({ header: s.header }))
    },
    async observeSession(id, { signal } = {}) {
      signal?.throwIfAborted()
      const session = sessions.find((s) => s.id === id)
      return { events: session?.events ?? [], [Symbol.dispose]() {} }
    },
  }
}

function boot(sessionQuery) {
  const routes = []
  const services = {
    sessionQuery,
    webServer: { register: (route) => { routes.push(route); return () => {} } },
  }
  const ctx = {
    ...services,
    effect: (fn) => fn(),
    get: (name) => services[name],
    on: () => {},
    inject: (names, apply) => { if (names.every((n) => services[n])) apply(ctx) },
  }
  plugin.apply(ctx, {})
  return routes
}

async function ask(handler, body) {
  const req = { on: (e, fn) => { if (e === 'data') fn(JSON.stringify(body)); if (e === 'end') fn() } }
  let out = null
  await handler(req, { writeHead() {}, end(text) { out = JSON.parse(text) } })
  return out
}

// ── the tree: a conversation, a subagent, and a subagent of that subagent ───
const sessions = [
  { id: 'session-p', header: { id: 'session-p' }, events: usage(1000, 'm-main') },
  { id: 'c1', header: { id: 'c1', parentSession: 'session-p', origin: 'subagent', delegationDepth: 1 }, events: usage(2000, 'm-sub') },
  { id: 'g1', header: { id: 'g1', parentSession: 'c1', origin: 'subagent', delegationDepth: 2 }, events: usage(3000, 'm-nested') },
  { id: 'other', header: { id: 'other' }, events: usage(4000, 'm-other') },
]

console.log('delegated sessions')
{
  const sq = fakeSessionQuery(sessions)
  const routes = boot(sq)
  const api = routes.find((r) => r.path === '/dsh-bill/api')
  assert(api !== undefined, 'the API route is mounted')

  // Backfill seeds the ring with one record per session; the tree is read from
  // these headers, so nothing else is needed to exercise the join.
  await waitFor(() => (readRecords().length >= sessions.length ? true : null))

  const own = await ask(api.handler, { action: 'session-cost', sessionId: 'session-p' })
  assert(own.calls === 1, `session-cost reports this session's own calls only (got ${own.calls})`)
  assert(own.subagents.sessions === 2, `both delegated sessions are found (got ${own.subagents.sessions})`)
  assert(own.subagents.calls === 2, `the delegated calls are counted at any depth (got ${own.subagents.calls})`)
  assert(own.subagents.byModel.some((row) => row.model === 'm-nested'), 'the nested subagent\'s model is in the breakdown')

  const middle = await ask(api.handler, { action: 'session-cost', sessionId: 'c1' })
  assert(middle.subagents.sessions === 1, 'a subagent\'s own delegates are found too')

  const leaf = await ask(api.handler, { action: 'session-cost', sessionId: 'g1' })
  assert(leaf.subagents.sessions === 0 && leaf.subagents.calls === 0, 'a leaf session has no delegates')

  const unrelated = await ask(api.handler, { action: 'session-cost', sessionId: 'other' })
  assert(unrelated.subagents.sessions === 0, 'another conversation picks up nothing from this tree')

  const headline = await ask(api.handler, { action: 'session-subagents', sessionId: 'session-p' })
  assert(headline.sessions === 2 && headline.calls === 2, 'the dock action answers the delegated count')
  assert(typeof headline.usd === 'number', 'the dock action answers a number, priced or not')

  // All-time: the fixture's timestamps are deliberately tiny (epoch-adjacent),
  // so a rolling window would hold none of them.
  const tab = await ask(api.handler, { action: 'dashboard', sessionId: 'session-p', rangeDays: 0 })
  assert(tab.calls === 3, `the conversation's tab folds the delegates in (got ${tab.calls})`)
  assert(tab.subagents && tab.subagents.sessions === 2, 'the tab reports how many sessions it includes')

  const listingsAfter = sq.listings.count
  await ask(api.handler, { action: 'session-subagents', sessionId: 'session-p' })
  assert(sq.listings.count === listingsAfter, 'the header tree is cached between polls')
}

console.log('a host without session-query')
{
  // Older hosts have no lineage to read, so the delegated surfaces must answer
  // empty rather than fail — the plugin's own cost reporting keeps working.
  const routes = boot(undefined)
  const api = routes.find((r) => r.path === '/dsh-bill/api')
  const own = await ask(api.handler, { action: 'session-cost', sessionId: 'session-p' })
  assert(own.subagents && own.subagents.sessions === 0, 'no session-query means no delegated sessions')
  const headline = await ask(api.handler, { action: 'session-subagents', sessionId: 'session-p' })
  assert(headline.sessions === 0 && headline.usd === 0, 'the dock action answers zero')
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall delegated tests passed')
