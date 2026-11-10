/**
 * A call nothing can price re-reads magpie's list and heals the record.
 *
 * The hourly window leaves a gap: magpie starts pricing a model, calls arrive,
 * and every one of them is recorded without a cost until the window closes. The
 * capture path closes it from the other side — an unpriced record asks magpie
 * for the list again (throttled) and, when the list moved, fills the amounts
 * still blank. Stored costs are never rewritten.
 *
 * Run: node tests/pricing-sync.test.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = path.join(os.tmpdir(), 'dsh-bill-pricing-sync-test')
fs.rmSync(HOME, { recursive: true, force: true })
process.env.DSH_HOME = HOME
// Its own catalogue cache: a fetch below must be a miss, not last run's copy.
const CACHE = path.join(os.tmpdir(), 'dsh-bill-pricing-sync-cache')
fs.rmSync(CACHE, { recursive: true, force: true })
process.env.TMPDIR = CACHE

const { default: plugin } = await import('../lib/index.js')

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}

// magpie's list, before and after it starts quoting the model under test.
const URL = 'http://127.0.0.1:3999/v1/models'
const FIRST = { data: [{ id: 'bp/known', display_name: 'Known', owned_by: 'bp', magpie_price: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 } }] }
const SECOND = { data: [...FIRST.data, { id: 'late/model', display_name: 'Late', owned_by: 'late', magpie_price: { input: 8, output: 40, cache_read: 0.2, cache_write: 10 } }] }
const hits = { magpie: 0, dev: 0 }

const savedFetch = globalThis.fetch
globalThis.fetch = async (input) => {
  const url = String(input)
  let body = JSON.stringify({ rates: { USD: 1 } })
  if (url === URL) { hits.magpie++; body = JSON.stringify(hits.magpie === 1 ? FIRST : SECOND) }
  else if (url.includes('models.dev')) { hits.dev++; body = JSON.stringify({}) }
  else if (url.includes('openrouter')) body = JSON.stringify({ data: [] })
  return { ok: true, text: async () => body, json: async () => JSON.parse(body) }
}

const instance = {}
const services = { webServer: { register: (r) => { instance.api = r.handler } } }
const ctx = {
  ...services,
  effect: (fn) => fn(),
  get: (name) => services[name],
  on: (name, fn) => { if (name === 'llm/stream') instance.stream = fn },
  inject: (names, apply) => { if (names.every((n) => services[n])) apply(ctx) },
}
plugin.apply(ctx, { magpieUrl: URL })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(check, ms = 3000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(20)
  }
  return check()
}

/** A call that spends 1M fresh input tokens — $8 at the price under test. */
async function call(model, sessionId) {
  async function* source() {
    yield { type: 'usage', usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
  }
  const options = {
    provider: 'late', model, sessionId,
    tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }
  for await (const _ of instance.stream(options, () => source())) { /* drain */ }
}

async function ask(body) {
  const req = { on: (e, fn) => { if (e === 'data') fn(JSON.stringify(body)); if (e === 'end') fn() } }
  let out = null
  await instance.api(req, { writeHead() {}, end(text) { out = JSON.parse(text) } })
  return out
}

/** The stored ring, as the file has it. */
function stored() {
  const file = path.join(HOME, 'dsh-bill', 'records.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

try {
  // The boot load, which carries the list from BEFORE the model was priced.
  assert(await until(() => hits.magpie >= 1 && hits.dev >= 1), 'the catalogue loads at boot')
  await sleep(100)
  const bootHits = hits.magpie

  await call('late/model', 'miss')
  assert(await until(() => hits.magpie === bootHits + 1), 'the unpriced record re-read the list once (' + (hits.magpie - bootHits) + ')')
  assert(hits.dev === 1, 'models.dev was not re-read (' + hits.dev + ')')

  // The re-read brought the model's price, and the recorded row was healed.
  assert(await until(() => {
    const row = stored().find((r) => r.sessionId === 'miss')
    return row && row.priced === true
  }), 'the re-read prices the row recorded without a cost')
  const healed = stored().find((r) => r.sessionId === 'miss')
  assert(Math.abs(healed.usd - 8) < 1e-9, 'at the rate the list now quotes (got ' + healed.usd + ')')
  assert(healed.base?.inputPerM === 8, 'and the stored base rate follows (' + healed.base?.inputPerM + ')')

  const dashboard = await ask({ action: 'dashboard', rangeDays: 0, sessionId: 'miss' })
  assert(Math.abs(dashboard.totalUsd - 8) < 1e-6, 'the dashboard counts it (got ' + dashboard.totalUsd + ')')

  // A model the list never prices must not turn every call into a fetch.
  await call('never/model', 'unpriced')
  await sleep(300)
  assert(hits.magpie === bootHits + 1, 'a miss inside the throttle does not fetch again (' + (hits.magpie - bootHits) + ')')
  const stuck = stored().find((r) => r.sessionId === 'unpriced')
  assert(stuck && stuck.priced === false, 'and the row stays honestly unpriced')
} finally {
  globalThis.fetch = savedFetch
  fs.rmSync(HOME, { recursive: true, force: true })
  fs.rmSync(CACHE, { recursive: true, force: true })
}

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
