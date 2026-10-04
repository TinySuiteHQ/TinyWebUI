/* The provider side of a turn: request shape, prompt caching, retries and the SSE stream. */
import { EVENT } from '../../public/shared/events.js';

/**
 * Caching has two layers, and only the first one is universal.
 *
 * Layer 1 -- the stable prefix -- is what `canonical`, append-only history and
 * frozen compaction below give every backend for free. llama.cpp, Ollama,
 * vLLM, LM Studio, DeepSeek, Gemini and OpenAI all cache on an exact prefix
 * match with no request field involved, so keeping the front of the request
 * byte-identical is where most of the saving comes from on most setups.
 *
 * Layer 2 -- explicit markers -- exists because a handful of gateways bill
 * cache writes separately and want to be told where to write. That is a
 * per-gateway wire dialect, not a fact about the model, so it lives in one
 * table here and is off unless we have a reason to believe it is understood.
 * An endpoint we do not recognise (which is every local runtime) gets layer 1
 * only: markers there are pure downside -- array content is the part strict
 * OpenAI-compatible servers reject, and they buy nothing on a backend that
 * already caches the prefix automatically.
 *
 * `cacheMode` in the config overrides the guess, so a new model or a gateway
 * we have never heard of is a config line, not a patch to this file.
 *
 *   'auto'     pick per the table below (default)
 *   'implicit' layer 1 only -- stable prefix, no marker fields
 *   'explicit' Anthropic-style cache_control breakpoints in message content
 *   'rolling'  OpenRouter top-level automatic cache_control
 *   'off'      no cache shaping at all
 */
export function isOpenRouter(cfg) {
  return /^https?:\/\/(?:[^/]+\.)?openrouter\.ai(?::\d+)?(?:\/|$)/i.test(cfg.baseUrl || '');
}

/** Loopback and LAN endpoints: a local runtime, whatever model it is serving. */
function isLocal(cfg) {
  let host = '';
  try { host = new URL(cfg.baseUrl || '').hostname.toLowerCase(); } catch { return false; }
  return host === 'localhost' || host === '::1' || host === 'host.docker.internal'
    || host.endsWith('.local') || /^127\./.test(host)
    || /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);
}

function isClaude(model) {
  return /claude|anthropic/i.test(model || '');
}

/**
 * Model families that bill cache writes and therefore want an explicit marker.
 * Matched at the family level on purpose: pinning exact model ids means every
 * new release needs a code change, and a marker on a sibling that does not
 * need one is ignored rather than fatal.
 *
 * Deliberately Anthropic-only. A marker is not free on everyone else: it turns
 * a message's content from a string into an array, and the rolling breakpoint
 * moves off that message next round, turning it back. Anthropic tolerates that
 * because cache_control only picks where to WRITE and its prefix matching
 * ignores the field -- but a gateway that prefix-matches the serialised request
 * sees a byte change in the middle of the prefix and misses everything after
 * it. DeepSeek, Qwen and Gemini all cache the prefix automatically, so layer 1
 * already gets the saving and the marker is pure downside.
 */
const NATIVE_ANTHROPIC = /claude|anthropic|amazon\.nova|nova-(?:lite|micro|pro|premier)/i;

/** Resolves config + endpoint + model to exactly one of the modes above. */
export function cacheMode(cfg) {
  const asked = cfg.cacheMode || 'auto';
  if (cfg.cache === false) return 'off';
  if (asked !== 'auto') return asked;

  // A pinned provider route means the caller has taken routing into their own
  // hands; automatic mode would quietly narrow it, so fall back to markers.
  // Only routing counts: policy fields like zdr or data_collection narrow the
  // pool without choosing an upstream, so they leave automatic mode alone.
  const route = cfg.extraBody?.provider || {};
  const pinned = Boolean(route.order?.length || route.only?.length);

  if (isOpenRouter(cfg)) {
    if (isClaude(cfg.model) && !pinned) return 'rolling';
    return NATIVE_ANTHROPIC.test(cfg.model || '') ? 'explicit' : 'implicit';
  }
  // Local runtimes cache the prefix themselves and are the strictest about
  // request shape. Never shape their wire.
  if (isLocal(cfg)) return 'implicit';
  // A direct Anthropic-compatible endpoint is the one remaining case worth
  // marking; anything else we have not identified gets the safe path.
  return NATIVE_ANTHROPIC.test(cfg.model || '') ? 'explicit' : 'implicit';
}

function cacheDirective(cfg) {
  const directive = { type: 'ephemeral' };
  if (isClaude(cfg.model) && cfg.cacheTtl === '1h') directive.ttl = '1h';
  return directive;
}

const REPLAY = { OMIT: 'omit', CONTENT: 'reasoning_content', DETAILS: 'reasoning_details' };

/**
 * Which reasoning a past assistant turn sends back. Structured reasoning goes
 * back wherever the gateway normalises it, not only where cache markers are on:
 * without it a model on a multi-round tool turn loses its plan between rounds,
 * and some (Gemini's thought signatures, Anthropic) reject the follow-up
 * outright. OpenRouter passes it to the upstream that produced it. Direct
 * DeepSeek wants its own plain `reasoning_content` on tool-call turns instead,
 * and rejects `reasoning_details`. Anything else is billed for reasoning it
 * ignores, so it gets none. `reasoningReplay` overrides this for a gateway the
 * table does not know.
 */
export function reasoningReplay(cfg) {
  if (cfg.reasoningReplay && cfg.reasoningReplay !== 'auto') return cfg.reasoningReplay;
  if (isOpenRouter(cfg) || cacheMode(cfg) === 'explicit') return REPLAY.DETAILS;
  let host = '';
  try { host = new URL(cfg.baseUrl || '').hostname.toLowerCase(); } catch { /* no endpoint set */ }
  return host === 'api.deepseek.com' ? REPLAY.CONTENT : REPLAY.OMIT;
}

/**
 * Prompt-cache shaping: one fixed key order for every message on the wire.
 *
 * Every provider caches on an exact prefix match, so the real work is keeping
 * the front of the request byte-identical between turns -- one system message
 * built the same way, tools in a stable order, history only ever appended to.
 * That alone is what buys the saving on the majority of models.
 *
 * Which is why this function exists rather than passing messages through: a
 * message must serialise the same whether it was appended a moment ago or
 * rebuilt from the database next turn, and JSON.stringify follows insertion
 * order. Without one canonical shape the two paths emit different bytes for
 * identical content and the whole prefix misses. Which reasoning goes back
 * is the provider's contract, see reasoningReplay.
 */
function canonical(m, replay) {
  const out = { role: m.role };
  // A tool-only assistant turn stores content as null, but some gateways (seen
  // on DeepInfra via OpenRouter) reject a null text part outright and want an
  // empty string instead. Only assistant+tool_calls hits this; every other
  // role still sends null through unchanged.
  out.content = (m.content == null && m.role === 'assistant' && m.tool_calls) ? '' : (m.content ?? null);
  if (m.tool_calls) out.tool_calls = m.tool_calls;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (replay === REPLAY.DETAILS && m.reasoning_details) out.reasoning_details = m.reasoning_details;
  // Only a tool-call turn: DeepSeek needs its reasoning to continue the turn
  // it belongs to and has no use for it on a finished answer.
  if (replay === REPLAY.CONTENT && m.role === 'assistant' && m.tool_calls && m.reasoning) {
    out.reasoning_content = m.reasoning;
  }
  return out;
}

/**
 * Marks a cache breakpoint on the newest text-bearing turn at or before `from`.
 * Only user/assistant text can carry it: an assistant message that is purely
 * tool_calls has null content, and tool results are left alone because not
 * every OpenAI-compatible gateway accepts array content there.
 */
function markBreakpoint(messages, from, directive) {
  for (let i = Math.min(from, messages.length - 1); i > 0; i--) {
    const m = messages[i];
    if (typeof m.content !== 'string' || !m.content) continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    messages[i] = {
      ...m,
      content: [{ type: 'text', text: m.content, cache_control: { ...directive } }]
    };
    return i;
  }
  return -1;
}

export function buildMessages(cfg, history, epochIndex = -1) {
  // Only 'explicit' shapes message content. 'rolling' is the strategy by
  // itself and must not be stacked with markers; 'implicit' and 'off' send
  // plain strings, which is what every strict OpenAI-compatible server wants.
  const bp = cacheMode(cfg) === 'explicit';
  const directive = cacheDirective(cfg);
  const system = {
    role: 'system',
    content: bp
      ? [{ type: 'text', text: cfg.systemPrompt, cache_control: { ...directive } }]
      : cfg.systemPrompt
  };

  // Kept for the whole history, not just the current turn: stripping it once a
  // turn is over would rewrite those bytes and miss the cache on the next turn.
  const replay = reasoningReplay(cfg);
  const messages = [system, ...history.map((m) => canonical(m, replay))];
  if (bp) {
    // Rolling breakpoint at the END of what we are sending, not behind it. Each
    // tool round appends an assistant turn and its results, and marking the
    // newest text message writes all of that to the cache so the next round
    // reads it back instead of re-paying for it. Anthropic uses cache_control
    // only to decide where to WRITE -- prefix matching ignores it -- so moving
    // the marker forward each round does not invalidate what is already cached.
    const rolling = markBreakpoint(messages, messages.length - 1, directive);
    // Second, pinned breakpoint on the frozen compacted prefix. The rolling one
    // moves every round and its entry expires; this one sits on a span that can
    // no longer change, so the expensive part of the conversation stays cached
    // for as long as the epoch lasts. Skipped when it would land on the same
    // message the rolling marker already claimed.
    if (epochIndex >= 0) {
      const at = epochIndex + 1; // +1 for the system message at index 0
      if (at < rolling || rolling === -1) markBreakpoint(messages, at, directive);
    }
  }
  return messages;
}

// Optional knobs, in the order we give them up. Gateways vary in what they
// accept, and none of these is worth failing a whole turn over: caching is an
// optimisation, tool_choice has a prompt-level fallback, and usage is cosmetic.
const OPTIONAL = [
  { probe: /cache_control|ephemeral/i, drop: 'cache' },
  { probe: /tool_choice/i, drop: 'tool_choice' },
  { probe: /stream_options|include_usage/i, drop: 'stream_options' }
];

/** Builds one request body, leaving out whatever this endpoint has refused. */
export function buildBody(cfg, { turn, tools, lastCall, epochIndex, chatId, relax }, disabled) {
  const body = {
    // Gateway-specific routing/knobs first, so nothing below can be clobbered.
    ...(cfg.extraBody || {}),
    model: cfg.model,
    messages: buildMessages(
      disabled.has('cache') ? { ...cfg, cache: false } : cfg, turn, epochIndex
    ),
    stream: true
  };

  // Last resort after the pinned provider has refused us repeatedly. Pinning
  // exists to keep the prompt cache on one upstream, but a warm cache is worth
  // less than a turn that finishes, so the pin yields before the turn does.
  if (relax && body.provider && body.provider.allow_fallbacks === false) {
    body.provider = { ...body.provider, allow_fallbacks: true };
  }

  // session_id is an OpenRouter field. Sending it anywhere else risks a strict
  // server rejecting an unknown key over something that would do nothing.
  if (isOpenRouter(cfg) && chatId && body.session_id == null) {
    body.session_id = String(chatId).slice(0, 256);
  }

  // Rolling mode: the gateway advances the breakpoint to the last cacheable
  // block itself, which is the only shape that keeps caching across client-side
  // tool results in an agentic loop.
  if (!disabled.has('cache') && cacheMode(cfg) === 'rolling') {
    body.cache_control = cacheDirective(cfg);
  }

  if (!disabled.has('stream_options')) body.stream_options = { include_usage: true };
  // Only send the sampling knobs that were actually set, so an unset one gets
  // the provider's default instead of ours.
  if (cfg.temperature != null) body.temperature = cfg.temperature;
  if (cfg.maxTokens != null) body.max_tokens = cfg.maxTokens;
  if (tools.length) {
    // The tool block stays in the request even on the final pass: dropping it
    // would change the cached prefix. `tool_choice: none` is what blocks the call.
    body.tools = tools;
    if (lastCall && !disabled.has('tool_choice')) body.tool_choice = 'none';
  }
  return body;
}

/**
 * Failures worth trying again: a busy or briefly broken upstream, not a bad
 * request. A rate limit is the common one, and it is the reason this exists --
 * pinning to a single provider for cache stability means its rate limit is now
 * the whole budget, and a 429 used to end the turn outright.
 */
const TRANSIENT = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 4;
// Rounds re-run after the stream itself fails, on top of post()'s retries.
export const STREAM_RETRIES = 2;

/** A failure reported inside an otherwise successful stream. */
export class StreamError extends Error {}
// How many refusals to take from a pinned provider before trying another one.
// Waiting out the full backoff first is the wrong trade: a provider that is
// rate-limited on its shared pool is usually limited for longer than any
// backoff we are willing to sit through, and a cold cache costs far less than
// half a minute of nothing.
const RELEASE_PIN_AFTER = 2;

/** How long to wait: what the provider asked for, else backing off with jitter. */
export function retryDelay(res, attempt) {
  const header = res?.headers?.get?.('retry-after');
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30000);
    const when = Date.parse(header);
    if (!Number.isNaN(when)) return Math.min(Math.max(when - Date.now(), 0), 30000);
  }
  // Jittered, so two tabs retrying the same upstream do not march in step.
  return Math.min(1000 * 2 ** attempt, 8000) * (0.5 + Math.random());
}

/** A sleep that a stop actually interrupts, rather than one you wait out. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Stopped.'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Stopped.'));
    }, { once: true });
    return undefined;
  });
}

/**
 * POSTs the completion, and if the gateway rejects it over one of the optional
 * knobs, drops that knob and retries. `disabled` is shared across the whole turn,
 * so we learn an endpoint's limits once rather than re-probing every round.
 *
 * A transient failure is retried on the same provider first -- that is the only
 * outcome that keeps both the turn and the prompt cache. Once those are spent,
 * a pinned route is released for one final attempt: a cold cache somewhere else
 * still beats losing the turn and everything already spent on it.
 */
export async function post(cfg, plan, signal, disabled, emit) {
  let retries = 0;
  let relaxed = false;

  const pinned = cfg.extraBody?.provider?.allow_fallbacks === false;

  const backOff = async (res, why) => {
    // A pin exists to keep the prompt cache on one upstream. Once that upstream
    // has refused us twice, the cache is not the binding constraint any more --
    // finishing the turn is. Retry elsewhere immediately rather than waiting.
    if (pinned && !relaxed && retries >= RELEASE_PIN_AFTER) {
      relaxed = true;
      emit({ type: EVENT.NOTICE, text: `${why} — releasing the provider pin (cache will be cold).` });
      return true;
    }
    if (retries < MAX_RETRIES) {
      retries++;
      const wait = retryDelay(res, retries);
      emit({
        type: EVENT.NOTICE,
        text: `${why} — retrying in ${(wait / 1000).toFixed(1)}s (${retries}/${MAX_RETRIES}).`
      });
      await sleep(wait, signal);
      return true;
    }
    return false;
  };

  for (;;) {
    let res;
    const body = buildBody(cfg, { ...plan, relax: relaxed }, disabled);
    plan.onRequest?.(body);
    try {
      res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        // Local runtimes are usually keyless, and the ranking headers are
        // OpenRouter's own -- neither belongs on a request to someone else.
        headers: {
          'content-type': 'application/json',
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
          ...(isOpenRouter(cfg)
            ? {
                'http-referer': 'https://github.com/TinySuiteHQ/tinywebui',
                'x-title': 'TinyWebUI'
              }
            : {})
        },
        body: JSON.stringify(body)
      });
    } catch (err) {
      // A dropped connection looks like nothing at all, so it is judged here
      // rather than by a status code. A stop is not a failure to retry.
      if (signal?.aborted) throw err;
      if (await backOff(null, `Network error (${err.message})`)) continue;
      throw err;
    }

    if (res.ok && res.body) return res;

    const text = await res.text();

    // A knob this endpoint refuses is not transient; dropping it is the fix.
    const culprit = res.status >= 400 && res.status < 500
      ? OPTIONAL.find((o) => !disabled.has(o.drop) && o.probe.test(text))
      : null;
    if (culprit) {
      disabled.add(culprit.drop);
      emit({ type: EVENT.NOTICE, text: `Provider rejected ${culprit.drop}; retrying without it.` });
      continue;
    }

    if (TRANSIENT.has(res.status)) {
      if (await backOff(res, `Provider returned ${res.status}`)) continue;
    }

    // A model with no vision support rejects image content with a 4xx rather
    // than any dedicated status code, and the raw provider text is often just
    // an opaque "invalid content" -- naming the actual cause here is the
    // difference between that and a clear, actionable error in the transcript.
    const hasImage = plan.turn.some((m) => Array.isArray(m.content)
      && m.content.some((p) => p?.type === 'image_url'));
    if (hasImage && res.status >= 400 && res.status < 500) {
      throw new Error(
        `This model doesn't appear to support image input. `
        + `Provider said: ${res.status} ${res.statusText}: ${text.slice(0, 300)}`
      );
    }

    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }
}

export async function* streamChunks(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try { yield JSON.parse(data); } catch { /* keepalive / partial */ }
    }
  }
}
