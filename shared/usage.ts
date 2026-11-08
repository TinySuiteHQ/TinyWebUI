/**
 * Reading a provider's usage object. Shared by both sides so the transcript's
 * per-turn line and the Statistics panel count the same tokens.
 *
 * Nothing here is standardised; each provider spells it differently, and some
 * report no cache figures at all -- then a hit is invisible, not absent. So
 * every reader returns null for "not reported" and the caller picks a default.
 *   OpenAI / Gemini / OpenRouter : prompt_tokens_details.cached_tokens
 *   OpenAI Responses             : input_tokens_details.cached_tokens
 *   Anthropic                    : cache_read_input_tokens (+ creation, billed extra)
 *   DeepSeek                     : prompt_cache_hit_tokens / prompt_cache_miss_tokens
 */

/** A usage object as some provider sent it: any shape, every field optional. */
// Provider JSON with no fixed shape: `any` keeps the optional-chain readers below terse.
export type RawUsage = { [field: string]: any };

export type UsageTally = {
  in: number, out: number, cached: number, written: number, discount: number,
  reported: boolean, raw: RawUsage[], provider: string | null, providers: string[]
};

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export const inputTokens = (u: RawUsage | null | undefined) => num(u?.prompt_tokens ?? u?.input_tokens);
export const outputTokens = (u: RawUsage | null | undefined) => num(u?.completion_tokens ?? u?.output_tokens);

export const cacheReads = (u: RawUsage | null | undefined) => num(
  u?.prompt_tokens_details?.cached_tokens
  ?? u?.input_tokens_details?.cached_tokens
  ?? u?.cache_read_input_tokens
  ?? u?.prompt_cache_hit_tokens
  ?? u?.cached_tokens
);

export const cacheWrites = (u: RawUsage | null | undefined) => num(
  u?.cache_creation_input_tokens
  ?? u?.cache_write_tokens
  ?? u?.prompt_tokens_details?.cache_write_tokens
  ?? u?.prompt_tokens_details?.cache_creation_tokens
  ?? u?.input_tokens_details?.cache_write_tokens
);

/** Folds one or more raw usage objects into the numbers a turn displays. */
export function tally(raws: RawUsage[]): UsageTally {
  const t: UsageTally = { in: 0, out: 0, cached: 0, written: 0, discount: 0, reported: false, raw: raws, provider: null, providers: [] };
  for (const u of raws) {
    if (u.provider) {
      t.provider = u.provider;
      // Distinct upstreams, in the order they served. A turn split across two
      // of them cannot cache between rounds, and summing would otherwise hide
      // that behind whichever one happened to serve last.
      if (!t.providers.includes(u.provider)) t.providers.push(u.provider);
    }
    t.in += inputTokens(u) ?? 0;
    t.out += outputTokens(u) ?? 0;
    t.cached += cacheReads(u) ?? 0;
    t.written += cacheWrites(u) ?? 0;
    t.discount += Number(u.cache_discount || 0);
    // "The provider said zero" is not "the provider said nothing".
    if (u.prompt_tokens_details || u.input_tokens_details || cacheReads(u) !== null || cacheWrites(u) !== null) t.reported = true;
  }
  return t;
}
