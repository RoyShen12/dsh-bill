/**
 * magpie's price list as an llm-pricing source.
 *
 * Offline: every check runs against a fixture shaped like magpie's
 * `/v1/models` (with `X-Magpie-Prices: 1`), and the one catalogue test feeds it
 * through an injected `fetch`. Run: node tests/magpie.test.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PricingCatalog } from 'llm-pricing'
import { DEFAULT_MAGPIE_URL, magpieModelsUrl, magpieSource, withMagpiePrices } from '../lib/magpie.js'

// os.tmpdir() consults TEMP on Windows and TMPDIR on POSIX.
const TEMP_ENV = process.platform === 'win32' ? 'TEMP' : 'TMPDIR'

let failed = 0
function assert(cond, msg) {
  if (cond) console.log('  ok -', msg)
  else { failed++; console.error('  FAIL -', msg) }
}

/** One `/v1/models` row, as magpie tells it to a caller asking for prices. */
function model(id, price) {
  return { id, display_name: id.toUpperCase(), owned_by: id.split('/')[0], magpie_price: price }
}

const FIXTURE = {
  data: [
    model('plain/model', { input: 0.15, output: 0.6, cache_read: 0.003, cache_write: 0.19 }),
    model('tiered/model', {
      input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125, cache_write_1h: 0.2,
      tiers: [{ above: 100000, input: 0.5, output: 2.5, cache_read: 0.05, cache_write: 0.625, cache_write_1h: 1 }],
    }),
    model('peak/model', {
      input: 0.15, output: 0.6, cache_read: 0.003, cache_write: 0, peak: 'weekdays',
    }),
    model('free/model', { input: 0, output: 0, cache_read: 0, cache_write: 0 }),
    // A routing group whose members differ in price: magpie quotes nothing.
    { id: 'group/mixed', display_name: 'Mixed', owned_by: 'group' },
  ],
}

const source = magpieSource(DEFAULT_MAGPIE_URL)
const table = source.parse(FIXTURE)

console.log('parse: ids and rates')
assert(source.name === 'magpie', 'source is named for its provenance')
assert(table.size === 4, 'the unpriced routing group is left out (' + table.size + ' of 5)')
const plain = table.get('plain/model')
assert(plain && plain.source === 'magpie', 'a priced model carries magpie as its source')
assert(plain.tier === 0, 'quotes are ranked first-party, so the exact id beats a bare resale name')
assert(plain.displayName === 'PLAIN/MODEL' && plain.providerId === 'plain', 'display name and provider come from the row')
const rates = plain.periods[0].rates
assert(Math.abs(rates.inputCostPerToken - 0.15e-6) < 1e-15, 'input is per token, not per million')
assert(Math.abs(rates.outputCostPerToken - 0.6e-6) < 1e-15, 'output is per token')
assert(Math.abs(rates.cacheReadInputCostPerToken - 0.003e-6) < 1e-15, 'cache read is per token')
assert(rates.cachedInputCostPerToken === rates.cacheReadInputCostPerToken, 'cached input mirrors the cache-read rate')
assert(Math.abs(rates.cacheCreationInputCostPerToken - 0.19e-6) < 1e-15, 'cache write is per token')
assert(table.has('free/model'), 'a zero price is a price: magpie bills nothing for it')
assert(plain.periods[0].peak === undefined, 'a model without a peak name has no peak schedule')

console.log('parse: long-context tiers')
const tiered = table.get('tiered/model')
const tiers = tiered.periods[0].contextTiers
assert(tiers?.length === 1 && tiers[0].abovePromptTokens === 100000, 'the tier threshold becomes abovePromptTokens')
assert(Math.abs(tiers[0].rates.inputCostPerToken - 0.5e-6) < 1e-15, 'the tier quotes its own rates')
assert(Math.abs(tiers[0].rates.cacheCreationInputCostPerToken - 0.625e-6) < 1e-15, 'cache write is priced inside the tier too')

console.log('parse: peak windows')
const peakSchedule = table.get('peak/model')
const peak = peakSchedule.periods[0]
assert(JSON.stringify(peak.peak.windowsUtc) === '[[1,4],[6,10]]', 'a weekday peak is DeepSeek hours, UTC')
assert(JSON.stringify(peak.peak.daysUtc) === '[1,2,3,4,5]', 'Monday to Friday')
assert(peak.peak.exceptDaysUtc === undefined, 'the weekday peak skips no holiday')
assert(Math.abs(peak.peak.rates.inputCostPerToken - 0.3e-6) < 1e-15, 'peak rates are twice the off-peak list price')
assert(Math.abs(peak.rates.inputCostPerToken - 0.15e-6) < 1e-15, 'the base rates stay the off-peak ones')
assert(peakSchedule.sqlMatch?.[0] === '%deepseek%', 'a time-varying schedule carries the pattern rows are anchored by')

console.log('parse: unknown peak name')
const odd = magpieSource(DEFAULT_MAGPIE_URL).parse({ data: [model('odd/model', { input: 1, output: 2, cache_read: 0.1, cache_write: 0, peak: 'lunar' })] })
assert(odd.get('odd/model').periods[0].peak === undefined, 'an unknown peak name falls back to one flat rate')

console.log('magpieModelsUrl')
assert(magpieModelsUrl('http://127.0.0.1:3425') === DEFAULT_MAGPIE_URL, 'a bare origin gains /v1/models')
assert(magpieModelsUrl('http://127.0.0.1:3425/v1') === DEFAULT_MAGPIE_URL, '/v1 gains /models')
assert(magpieModelsUrl('http://127.0.0.1:3425/v1/models/') === DEFAULT_MAGPIE_URL, 'a trailing slash is tolerated')
assert(magpieModelsUrl(' https://magpie.lan/v1/models ') === 'https://magpie.lan/v1/models', 'whitespace is trimmed')

console.log('withMagpiePrices')
{
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), headers: init?.headers }); return { ok: true } }
  try {
    const ask = withMagpiePrices(DEFAULT_MAGPIE_URL)
    await ask(DEFAULT_MAGPIE_URL, { headers: { accept: 'application/json' } })
    await ask('https://models.dev/api.json', { headers: { accept: 'application/json' } })
    await withMagpiePrices(DEFAULT_MAGPIE_URL, 'gw-key')(DEFAULT_MAGPIE_URL, { headers: { accept: 'application/json' } })
  } finally {
    globalThis.fetch = original
  }
  assert(seen[0].headers['X-Magpie-Prices'] === '1', 'magpie is asked for its price block')
  assert(seen[0].headers.accept === 'application/json', 'the catalogue’s own accept header survives')
  assert(seen[1].headers['X-Magpie-Prices'] === undefined, 'no other source is sent the header')
  assert(seen[2].headers.authorization === 'Bearer gw-key', 'a gateway key rides along when configured')
}

console.log('catalogue: pricing through the source')
{
  const body = JSON.stringify(FIXTURE)
  const catalog = new PricingCatalog({
    sources: [magpieSource(DEFAULT_MAGPIE_URL)],
    fetch: async () => ({ ok: true, text: async () => body }),
    onWarn: () => {},
  })
  await catalog.ensureLoaded()
  const at = Date.parse('2026-11-09T12:00:00Z') // a Monday, off-peak
  const peakAt = Date.parse('2026-11-09T02:00:00Z') // inside 01-04 UTC

  const quote = catalog.getPrice('plain/model', at)
  assert(quote?.source === 'magpie', 'the catalogue resolves the id from magpie')
  assert(Math.abs(quote.inputCostPerToken - 0.15e-6) < 1e-15, 'and quotes its rate')

  const peakQuote = catalog.getPrice('peak/model', peakAt)
  assert(Math.abs(peakQuote.inputCostPerToken - 0.3e-6) < 1e-15, 'a peak hour bills the doubled rate')
  const offQuote = catalog.getPrice('peak/model', at)
  assert(Math.abs(offQuote.inputCostPerToken - 0.15e-6) < 1e-15, 'an off-peak hour bills the list rate')

  // A record IS one request, which is what selects a long-context tier; the
  // plugin passes this on every priceRecord call.
  const args = { model: 'tiered/model', at, inputIncludesCache: false, inputTokens: 150000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
  const asRequest = catalog.estimate({ ...args, perRequest: true })
  const withoutRequest = catalog.estimate(args)
  assert(Math.abs(asRequest.cost - 0.075) < 1e-9, '150k prompt tokens price at the tier rate ($0.075, got ' + asRequest.cost + ')')
  assert(Math.abs(withoutRequest.cost - 0.015) < 1e-9, 'without perRequest the tier is skipped ($0.015, got ' + withoutRequest.cost + ')')
}

console.log('catalogue: magpie is re-read hourly, models.dev is not')
{
  // The plugin keeps its catalogue caches on disk; using a fresh temp
  // directory (before the module is imported, so the module-level pricing gets
  // it too) means every fetch below is a miss rather than last run's copy.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bill-magpie-refresh-'))
  const savedTmpdir = process.env[TEMP_ENV]
  const savedFetch = globalThis.fetch
  const savedNow = Date.now
  process.env[TEMP_ENV] = scratch

  const DEV_BODY = JSON.stringify({
    magpieprobe: { models: { 'plain/model': { cost: { input: 1.5, output: 3 }, name: 'Resale probe' } } },
  })
  const OPENROUTER_BODY = JSON.stringify({ data: [] })
  const hits = { magpie: 0, dev: 0, openrouter: 0 }
  const at = Date.parse('2026-11-09T12:00:00Z') // a Monday, off-peak
  let clock = at

  globalThis.fetch = async (input) => {
    const url = String(input)
    let body = OPENROUTER_BODY
    if (url === DEFAULT_MAGPIE_URL) { hits.magpie++; body = JSON.stringify(FIXTURE) }
    else if (url.includes('models.dev')) { hits.dev++; body = DEV_BODY }
    else hits.openrouter++
    return { ok: true, text: async () => body }
  }
  Date.now = () => clock

  try {
    const { createPricing } = await import('../lib/pricing.js')
    const pricing = createPricing({ magpieUrl: DEFAULT_MAGPIE_URL })
    await pricing.ensurePricingLoaded()
    assert(hits.magpie === 1, 'the first load asks magpie (' + hits.magpie + ')')
    assert(hits.dev === 1, 'and models.dev, once (' + hits.dev + ')')

    // Both catalogues price this id; magpie's quote is the one it bills.
    const rec = { model: 'plain/model', time: at, inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    assert(Math.abs(pricing.priceRecord(rec).usd - 0.15) < 1e-9, 'magpie beats models.dev on the same id (got ' + pricing.priceRecord(rec).usd + ')')

    clock = at + 30 * 60 * 1000
    await pricing.ensurePricingLoaded()
    assert(hits.magpie === 1, 'half an hour later nothing is re-fetched')

    clock = at + 61 * 60 * 1000
    await pricing.ensurePricingLoaded()
    assert(hits.magpie === 2, 'an hour later magpie is asked again (' + hits.magpie + ')')
    assert(hits.dev === 1, 'models.dev still is not (' + hits.dev + ')')
  } finally {
    globalThis.fetch = savedFetch
    Date.now = savedNow
    if (savedTmpdir === undefined) delete process.env[TEMP_ENV]
    else process.env[TEMP_ENV] = savedTmpdir
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('catalogue: an unpriced call re-reads the list')
{
  // Same isolation as the refresh test: a scratch temp directory makes every fetch
  // below a miss rather than a copy on disk, and a frozen clock decides what
  // "the fetch landed at" means.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bill-magpie-miss-'))
  const savedTmpdir = process.env[TEMP_ENV]
  const savedFetch = globalThis.fetch
  const savedNow = Date.now
  process.env[TEMP_ENV] = scratch

  // A model magpie starts pricing after this plugin read its list — the shape
  // of the 2026-11-10 Claude Fable 5.2 additions.
  const LATE = model('late/model', { input: 8, output: 40, cache_read: 0.2, cache_write: 10 })
  const BEFORE = JSON.stringify(FIXTURE)
  const AFTER = JSON.stringify({ data: [...FIXTURE.data, LATE] })
  const hits = { magpie: 0, dev: 0 }
  const at = Date.parse('2026-11-09T12:00:00Z') // a Monday, off-peak
  let clock = at
  // Its own URL, so this block gets its own catalogues: catalogFor keys them
  // by configuration, and the hourly block above already owns the default one.
  const LOCAL_URL = 'http://127.0.0.1:3999/v1/models'

  globalThis.fetch = async (input) => {
    const url = String(input)
    let body = JSON.stringify({ data: [] })
    if (url === LOCAL_URL) { hits.magpie++; body = hits.magpie === 1 ? BEFORE : AFTER }
    else if (url.includes('models.dev')) { hits.dev++; body = JSON.stringify({ magpieprobe: { models: {} } }) }
    return { ok: true, text: async () => body }
  }
  Date.now = () => clock

  try {
    const { createPricing } = await import('../lib/pricing.js')
    const pricing = createPricing({ magpieUrl: LOCAL_URL })
    await pricing.ensurePricingLoaded()
    assert(hits.magpie === 1 && hits.dev === 1, 'the catalogues load once, from both sources')

    const rec = { model: 'late/model', time: at, inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    assert(pricing.priceRecord(rec).priced === false, 'a model the list does not carry yet is unpriced')

    clock = at + 60 * 1000
    assert(await pricing.syncPrices() === true, "a miss forces magpie's list to be re-read")
    assert(hits.magpie === 2, 'exactly one extra fetch (' + hits.magpie + ')')
    assert(hits.dev === 1, 'models.dev keeps its own clock (' + hits.dev + ')')

    const now = pricing.priceRecord({ ...rec })
    assert(now.priced === true && Math.abs(now.usd - 8) < 1e-9, "the same call prices at the list's new rate (got " + now.usd + ')')

    assert(await pricing.syncPrices() === false, 'a second miss inside the throttle does not fetch again')
    assert(hits.magpie === 2, 'still two fetches (' + hits.magpie + ')')

    clock = at + 7 * 60 * 1000
    assert(await pricing.syncPrices() === true, 'after the throttle a miss re-reads again')
    assert(hits.magpie === 3, 'and that is the third fetch (' + hits.magpie + ')')
  } finally {
    globalThis.fetch = savedFetch
    Date.now = savedNow
    if (savedTmpdir === undefined) delete process.env[TEMP_ENV]
    else process.env[TEMP_ENV] = savedTmpdir
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('syncPrices: nothing to sync without a magpie')
{
  const { createPricing } = await import('../lib/pricing.js')
  const pricing = createPricing()
  assert(await pricing.syncPrices() === false, 'models.dev alone has no list to re-read on a miss')
}

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
