/**
 * magpie's own price list as an `llm-pricing` source.
 *
 * magpie is the gateway the calls actually go through, so the price it quotes
 * is the price it bills: the user's own ModelPrices, each provider's price
 * rate and a remote magpie's prices are already folded in, which is exactly
 * what its Usage page counts. models.dev quotes a reseller's list instead —
 * `codingplan/deepseek-v4.1-flash` at twice what magpie charges, for one — so
 * this source goes FIRST and models.dev keeps answering the ids magpie does
 * not price (its routing groups, a subscription-only model).
 *
 * Two things about the endpoint are not obvious:
 *
 *   - `magpie_price` is only told to a caller that asks with
 *     `X-Magpie-Prices: 1`, and only to one on this computer (or one magpie is
 *     shared with by a gateway key). {@link withMagpiePrices} adds the header;
 *     the loopback call needs no key.
 *   - the figures are USD per MILLION tokens with `cache_write_1h`, `tiers`
 *     and a `peak` NAME, where llm-pricing wants per-token rates, context
 *     tiers and a peak WINDOW. The name→window table below is the only
 *     translation; `cache_write_1h` needs none, because magpie quotes it at
 *     exactly 2× input, which is what the library already assumes
 *     (`CACHE_CREATE_1H_INPUT_MULTIPLIER`).
 *
 * @module dsh-bill/magpie
 */

import { OVERRIDES } from 'llm-pricing/internal'

/** Where a magpie on this computer answers, and what it calls the list. */
export const DEFAULT_MAGPIE_URL = 'http://127.0.0.1:3425/v1/models'

/** What a call in a peak window costs, as a multiple of the off-peak list price. */
const PEAK_FACTOR = 2

const WEEKDAYS = [1, 2, 3, 4, 5]

/**
 * DeepSeek's own peak hours, borrowed from the library's DeepSeek override
 * rather than restated here: the two must agree (magpie's `peak: "deepseek"`
 * means the same schedule), and the holiday list it carries needs a year
 * added each November. Taking it from one place means only that place rots.
 */
const DEEPSEEK_PEAK = OVERRIDES['deepseek-flash']?.periods?.find((period) => period.peak)?.peak

/**
 * The window a `peak` name stands for, or null for a price that holds around
 * the clock. Unknown names are treated as flat: the quote is then the
 * off-peak rate at every hour, which understates a peak call instead of
 * inventing hours it never had.
 */
function peakWindows(name) {
  if (name === 'ollama') return { windowsUtc: [[12, 18]], daysUtc: WEEKDAYS }
  if (name !== 'weekdays' && name !== 'deepseek') return null
  if (name === 'deepseek' && DEEPSEEK_PEAK) {
    return {
      windowsUtc: DEEPSEEK_PEAK.windowsUtc,
      daysUtc: DEEPSEEK_PEAK.daysUtc,
      exceptDaysUtc: DEEPSEEK_PEAK.exceptDaysUtc,
    }
  }
  return { windowsUtc: [[1, 4], [6, 10]], daysUtc: WEEKDAYS }
}

/** A per-million figure as the per-token rate llm-pricing multiplies by. */
const perToken = (value) => Number(value) / 1e6

/** One cost block as a rate card. `cachedInput` mirrors the cache-read rate. */
function ratesOf(price) {
  const read = perToken(price.cache_read)
  return {
    inputCostPerToken: perToken(price.input),
    outputCostPerToken: perToken(price.output),
    cacheReadInputCostPerToken: read,
    cachedInputCostPerToken: read,
    cacheCreationInputCostPerToken: perToken(price.cache_write),
  }
}

/** The same cost block at `multiplier` times every rate. */
function scaledRates(price, multiplier) {
  const rates = ratesOf(price)
  for (const key of Object.keys(rates)) rates[key] *= multiplier
  return rates
}

/**
 * magpie's `/v1/models` as an `llm-pricing` source.
 *
 * `tier: 0` is deliberate: llm-pricing ranks a lookup's candidate spellings by
 * it, and models.dev files the bare `deepseek-v4.1-flash` as first-party
 * (`tier: 0` too) while magpie's quote is the exact `provider/model` id. Left
 * unranked, that bare name won eight ids that magpie prices.
 *
 * @param {string} url - the list's full URL, e.g. {@link DEFAULT_MAGPIE_URL}.
 */
export function magpieSource(url) {
  return {
    name: 'magpie',
    url,
    parse(json) {
      const map = new Map()
      for (const model of json?.data ?? []) {
        const price = model?.magpie_price
        if (!price || typeof model.id !== 'string') continue
        const period = { from: Number.NEGATIVE_INFINITY, rates: ratesOf(price) }
        const windows = peakWindows(price.peak)
        if (windows) period.peak = { ...windows, rates: scaledRates(price, PEAK_FACTOR) }
        if (Array.isArray(price.tiers) && price.tiers.length > 0) {
          period.contextTiers = [...price.tiers]
            .sort((a, b) => a.above - b.above)
            .map((tier) => ({ abovePromptTokens: tier.above, rates: ratesOf({ ...price, ...tier }) }))
        }
        map.set(model.id.toLowerCase(), {
          displayName: model.display_name,
          source: 'magpie',
          tier: 0,
          providerId: model.owned_by,
          // A schedule that varies with the hour needs the LIKE pattern the
          // library anchors its rows by; without one every load warns about
          // the peak-priced models. DeepSeek is the only vendor here that
          // bills this way, and its ids all carry the name.
          ...(windows ? { sqlMatch: ['%deepseek%'] } : {}),
          periods: [period],
        })
      }
      return map
    },
  }
}

/**
 * `fetch` for the catalogue that asks magpie for the price block.
 *
 * `PricingSource` carries no headers of its own — the catalogue fetches every
 * source with nothing but `accept` — so the one header magpie gates its prices
 * on is added here, and only for magpie's own URL.
 *
 * @param {string} url - the same URL the source was built with.
 * @param {string} [key] - a magpie gateway key, for a magpie on another
 *   computer that shares its prices; a loopback one needs none.
 */
export function withMagpiePrices(url, key) {
  const headers = key ? { 'X-Magpie-Prices': '1', authorization: `Bearer ${key}` } : { 'X-Magpie-Prices': '1' }
  return (input, init = {}) => {
    if (String(input) !== url) return globalThis.fetch(input, init)
    return globalThis.fetch(input, { ...init, headers: { ...(init.headers ?? {}), ...headers } })
  }
}

/**
 * The list URL from what a user would write in config.
 *
 * `http://127.0.0.1:3425`, `.../v1` and the full `.../v1/models` all mean the
 * same endpoint, and a config that silently 404s is worse than one that is
 * understood.
 */
export function magpieModelsUrl(base) {
  const trimmed = String(base).trim().replace(/\/+$/, '')
  if (trimmed.endsWith('/models')) return trimmed
  if (trimmed.endsWith('/v1')) return trimmed + '/models'
  return trimmed + '/v1/models'
}
