import type { LanguageModelUsage } from "ai"

import { DOLLAR } from "@/lib/billing/format"
import type { GameModelId } from "@/lib/games/model-catalog"

/**
 * A rate quoted the way OpenAI publishes it — dollars per million tokens —
 * as billionths of a dollar per million tokens.
 *
 * Written as a decimal and rounded through thousandths of a dollar so the table
 * below reads like the price list it came from. Whole cents are not enough
 * here: some published rates, like a $0.125 cache write, sit between two cents.
 */
function perMillionTokens(dollars: number): bigint {
  return BigInt(Math.round(dollars * 1000)) * (DOLLAR / 1000n)
}

const TOKENS_PER_MILLION = 1_000_000n

/**
 * A request whose input exceeds this many tokens is billed at a higher tier
 * for the *whole* request, not only for the tokens past the line.
 */
const LONG_CONTEXT_THRESHOLD = 272_000

type ModelRates = {
  /** Input tokens that were neither read from nor written to the cache. */
  input: bigint
  /** Input tokens served from the cache. */
  cacheRead: bigint
  /** Input tokens written to the cache. */
  cacheWrite: bigint
  /** Includes reasoning tokens, which OpenAI bills as output. */
  output: bigint
}

/**
 * What each model in the catalog costs, per million tokens, at standard
 * processing and up to 272K input tokens.
 *
 * Source: OpenAI's published pricing, checked 2026-10-27. The cache-read
 * discount differs by model (90% off on Astra and Luna, 95% off on 6.1 Sol), so
 * the rates are written out rather than derived from a multiplier — one that
 * changes for a single model would otherwise silently misprice every row.
 *
 * `satisfies` rather than an annotation, so a model added to the catalog and
 * forgotten here is a type error rather than an undefined rate that prices a
 * turn at zero.
 */
export const MODEL_RATES = {
  "gpt-6-astra": {
    input: perMillionTokens(10),
    cacheRead: perMillionTokens(1),
    cacheWrite: perMillionTokens(12.5),
    output: perMillionTokens(50),
  },
  "gpt-6.1-sol": {
    input: perMillionTokens(2),
    cacheRead: perMillionTokens(0.1),
    cacheWrite: perMillionTokens(2.5),
    output: perMillionTokens(10),
  },
  "gpt-6-luna": {
    input: perMillionTokens(0.1),
    cacheRead: perMillionTokens(0.01),
    // Not confirmed against OpenAI's page: 1.25x the input rate, which is what
    // the Sol models charge. Check it against the first real invoice line.
    cacheWrite: perMillionTokens(0.125),
    output: perMillionTokens(0.5),
  },
} satisfies Record<GameModelId, ModelRates>

function costOf(tokens: number | undefined, rate: bigint): bigint {
  if (!tokens || tokens < 0) {
    return 0n
  }

  // Truncates the fraction below a billionth of a dollar, which at these rates
  // is a fraction of a single token's cost.
  return (BigInt(tokens) * rate) / TOKENS_PER_MILLION
}

/**
 * What one step of a turn cost, in billionths of a dollar.
 *
 * The token classes are priced separately because they differ by more than an
 * order of magnitude: on Astra a cached input token costs a tenth of a fresh
 * one and a cache write costs a quarter more, so a long build — which is mostly
 * the same context read back over and over — is billed nothing like its raw
 * token count suggests.
 *
 * `inputTokens` is the *total*, cached tokens included, so it is only used to
 * derive the fresh share when the provider doesn't report one: pricing it all
 * at the fresh rate would charge full price for reads that cost a fraction.
 */
export function priceStep({
  modelId,
  usage,
}: {
  modelId: GameModelId
  usage: LanguageModelUsage
}): bigint {
  const rates = MODEL_RATES[modelId]
  const { noCacheTokens, cacheReadTokens, cacheWriteTokens } =
    usage.inputTokenDetails

  // Prefer the provider's own count of uncached tokens. Without one, whatever
  // the cache didn't account for is fresh — which also covers a provider that
  // reports no breakdown at all, rather than billing its input as free.
  const fresh =
    noCacheTokens ??
    Math.max(
      0,
      (usage.inputTokens ?? 0) - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0)
    )

  const inputCost =
    costOf(fresh, rates.input) +
    costOf(cacheReadTokens, rates.cacheRead) +
    costOf(cacheWriteTokens, rates.cacheWrite)
  const outputCost = costOf(usage.outputTokens, rates.output)

  // Past the threshold the whole request is repriced: 2x input and cache
  // rates, 1.5x output. A turn is a read-edit-read loop whose context only
  // grows, so a long one can cross it on its later steps.
  if ((usage.inputTokens ?? 0) > LONG_CONTEXT_THRESHOLD) {
    return inputCost * 2n + (outputCost * 3n) / 2n
  }

  return inputCost + outputCost
}
