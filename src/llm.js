import { toWire } from './store.js';
import { digest, planEpoch, applyEpoch, estimateTokens } from './compact.js';

/** How many rounds are left before the budget note starts pressing for an answer. */
const WARN_ROUNDS = 2;

/**
 * What the model is told about its remaining tool budget, and where.
 *
 * A model that does not know its budget spends it badly: it opens a fourth
 * search on round eleven of twelve and gets cut off mid-gather. So every round
 * carries the count, and the last two carry a warning.
 *
 * The placement is the whole trick. This message is appended after the last
 * message of the request and is never written to the store, which is what keeps
 * it free. A note written into the conversation would sit inside every later
 * prefix, and since its count changes each round it would move the divergence
 * point back to wherever the note was and throw away the cache from there on --
 * the exact failure the append-only rule exists to prevent. At the tail it is
 * outside every future prefix instead: round N+1 rebuilds the history from the
 * store, so round N's note is simply not in it, and the two requests still
 * share every byte of real history.
 *
 * (It does cost its own tokens each round, and on a provider that caches in
 * fixed-size blocks it can leave the final partial block of history unstored.
 * Both are tens of tokens against a prefix in the tens of thousands.)
 */
function budgetNote(round, maxRounds) {
  const rounds = (n) => `${n} round${n === 1 ? '' : 's'}`;
  const left = maxRounds - round;

  if (left <= 0) {
    return {
      role: 'system',
      content: [
        `The tool budget for this message is spent (${rounds(maxRounds)} used).`,
        'No further tool calls are possible.',
        'Answer now using only what you have already gathered. State plainly what you could',
        'not determine and what would have been needed to determine it.'
      ].join(' ')
    };
  }

  const bits = [];
  if (round === 0) {
    // Said once, in full: what a round is, and that running out is not the end
    // of the turn. Both change how a model paces itself.
    bits.push(`Tool budget for this message: ${rounds(maxRounds)}.`);
    bits.push('One round is one reply that calls tools, however many calls it makes at once.');
    bits.push('When the budget runs out you get one final round with tools disabled,'
      + ' to answer from what you gathered.');
  } else {
    bits.push(`Tool budget: ${rounds(left)} of ${maxRounds} remaining.`);
  }
  if (left <= WARN_ROUNDS) {
    bits.push(`Only ${rounds(left)} left -- stop broadening, gather just what you still`
      + ' need, and be ready to answer from what you have.');
  }
  return { role: 'system', content: bits.join(' ') };
}

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
function isOpenRouter(cfg) {
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
  const pinned = Object.keys(cfg.extraBody?.provider || {}).length > 0;

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
 * identical content and the whole prefix misses. Reasoning text is dropped
 * here too: DeepSeek
 * documents that reasoning_content must not be sent back, everyone else just
 * bills for it, and the structured form survives only where it is required --
 * Anthropic rejects a follow-up tool request without it.
 */
function canonical(m, keepDetails) {
  const out = { role: m.role };
  out.content = m.content ?? null;
  if (m.tool_calls) out.tool_calls = m.tool_calls;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (keepDetails && m.reasoning_details) out.reasoning_details = m.reasoning_details;
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

export { budgetNote };

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

  const messages = [system, ...history.map((m) => canonical(m, bp))];
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
// How many refusals to take from a pinned provider before trying another one.
// Waiting out the full backoff first is the wrong trade: a provider that is
// rate-limited on its shared pool is usually limited for longer than any
// backoff we are willing to sit through, and a cold cache costs far less than
// half a minute of nothing.
const RELEASE_PIN_AFTER = 2;

/** How long to wait: what the provider asked for, else backing off with jitter. */
function retryDelay(res, attempt) {
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
function sleep(ms, signal) {
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
async function post(cfg, plan, signal, disabled, emit) {
  let retries = 0;
  let relaxed = false;

  const pinned = cfg.extraBody?.provider?.allow_fallbacks === false;

  const backOff = async (res, why) => {
    // A pin exists to keep the prompt cache on one upstream. Once that upstream
    // has refused us twice, the cache is not the binding constraint any more --
    // finishing the turn is. Retry elsewhere immediately rather than waiting.
    if (pinned && !relaxed && retries >= RELEASE_PIN_AFTER) {
      relaxed = true;
      emit({ type: 'notice', text: `${why} — releasing the provider pin (cache will be cold).` });
      return true;
    }
    if (retries < MAX_RETRIES) {
      retries++;
      const wait = retryDelay(res, retries);
      emit({
        type: 'notice',
        text: `${why} — retrying in ${(wait / 1000).toFixed(1)}s (${retries}/${MAX_RETRIES}).`
      });
      await sleep(wait, signal);
      return true;
    }
    return false;
  };

  for (;;) {
    let res;
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
        body: JSON.stringify(buildBody(cfg, { ...plan, relax: relaxed }, disabled))
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
      emit({ type: 'notice', text: `Provider rejected ${culprit.drop}; retrying without it.` });
      continue;
    }

    if (TRANSIENT.has(res.status)) {
      if (await backOff(res, `Provider returned ${res.status}`)) continue;
    }

    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }
}

async function* streamChunks(res) {
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

/**
 * Runs the full agentic loop: stream a completion, run any MCP tool calls,
 * feed the results back, repeat. `emit(event)` is called for every UI event.
 * Returns the messages appended to the conversation.
 */
export async function runChat({ cfg, chatId, store, tools, hub, emit, signal }) {
  const appended = [];
  // Optional request fields this endpoint has already refused, learned once.
  const disabled = new Set();

  const maxRounds = Math.max(1, cfg.maxToolRounds || 12);

  let rows = store.messages(chatId);
  const chat = store.getChat(chatId);

  // Compaction is decided once, here, before the first request of the turn --
  // never between rounds. Within a turn the prefix may only grow, so a round
  // can always read back what the previous round wrote to the cache.
  const threshold = cfg.compactThreshold || 0;
  if (threshold > 0) {
    // Providers disagree about reporting usage and some report none at all, so
    // fall back to a size estimate rather than never compacting.
    const wire = rows.map(toWire);
    const lastUsage = [...rows].reverse().find((r) => r.usage_json);
    const promptTokens = lastUsage
      ? JSON.parse(lastUsage.usage_json).prompt_tokens || estimateTokens(wire)
      : estimateTokens(wire);
    const plan = planEpoch(rows, {
      threshold,
      keepTurns: Math.max(1, cfg.keepTurns || 2),
      promptTokens
    });
    const done = plan && applyEpoch(store, chat, plan);
    if (done) {
      rows = store.messages(chatId);
      emit({
        type: 'notice',
        text: `Context compacted (epoch ${done.epoch}): ${done.saved.toLocaleString('en-US')} chars of earlier tool output moved out of the window. Use context_expand to read any of it.`
      });
      emit({ type: 'compacted', epoch: done.epoch, boundarySeq: done.boundarySeq, saved: done.saved });
    }
  }

  const working = rows.map(toWire);
  // Index of the last message inside the frozen prefix, for the pinned
  // breakpoint. -1 before the first epoch, when there is nothing frozen yet.
  const boundarySeq = store.getChat(chatId).boundary_seq;
  const epochIndex = boundarySeq >= 0
    ? rows.findIndex((r) => r.seq >= boundarySeq) - 1
    : -1;
  const toolCtx = { store, chatId, budget: cfg.expandCharBudget || 8000 };

  // One extra pass past the budget: tools are mechanically refused there, so the
  // model spends it writing an answer instead of leaving the turn unfinished.
  for (let round = 0; round <= maxRounds; round++) {
    const lastCall = round === maxRounds;
    // No tools, no budget to report -- the note would be noise about a limit
    // that cannot be reached.
    const turn = tools.length ? [...working, budgetNote(round, maxRounds)] : working;

    if (lastCall) {
      emit({
        type: 'notice',
        text: `Tool budget spent (${maxRounds} rounds) — answering with what was gathered.`
      });
    }

    const res = await post(cfg, { turn, tools, lastCall, epochIndex, chatId }, signal, disabled, emit);

    let content = '';
    let reasoning = '';
    const reasoningDetails = [];
    const toolCalls = [];
    let usage = null;
    // Which upstream actually served this round. A gateway that routes one
    // model across several providers gives each its own cache, so a round that
    // lands somewhere new misses in full however stable the prefix was --
    // indistinguishable from a prefix bug unless the provider is on the record.
    let provider = null;

    for await (const chunk of streamChunks(res)) {
      if (chunk.usage) usage = chunk.usage;
      if (chunk.provider) provider = chunk.provider;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      // Reasoning is spelled differently per provider: `reasoning` on OpenRouter,
      // `reasoning_content` on DeepSeek/Qwen. Both are plain text deltas.
      const think = delta.reasoning ?? delta.reasoning_content;
      if (think) {
        reasoning += think;
        emit({ type: 'reasoning', delta: think });
      }
      // Structured form, which has to be echoed back verbatim or providers reject
      // the follow-up request that carries tool results.
      for (const d of delta.reasoning_details || []) {
        const slot = (reasoningDetails[d.index ?? reasoningDetails.length] ||= { ...d, text: '' });
        if (d.text) slot.text += d.text;
        if (d.summary) slot.summary = (slot.summary || '') + d.summary;
      }
      if (delta.content) {
        content += delta.content;
        emit({ type: 'text', delta: delta.content });
      }
      for (const tc of delta.tool_calls || []) {
        const slot = (toolCalls[tc.index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
    }

    // A provider that ignores tool_choice could still emit calls here. Dropping
    // them keeps history valid, since nothing will produce their results.
    if (lastCall) toolCalls.length = 0;

    const assistant = { role: 'assistant', content: content || null };
    // Keep both: `reasoning_details` is what the provider needs echoed back,
    // `reasoning` is the plain text the transcript replays from. Storing only
    // the former loses every thinking block when a saved chat is reopened.
    if (reasoningDetails.length) {
      const details = reasoningDetails.filter(Boolean);
      assistant.reasoning_details = details;
      if (!reasoning) reasoning = details.map((d) => d.text || d.summary || '').join('');
    }
    if (reasoning) assistant.reasoning = reasoning;
    if (toolCalls.length) assistant.tool_calls = toolCalls.filter(Boolean);
    // Usage rides on the message rather than living only in a transient event,
    // so a reopened chat can still show what each round cost and how much of it
    // was a cache read. Without that there is no way to tell whether any of the
    // caching or compaction work here is actually paying off.
    if (usage) assistant.usage = { ...usage, ...(provider ? { provider } : {}) };
    working.push(assistant);
    appended.push(assistant);
    store.addMessage(chatId, assistant);
    if (usage) emit({ type: 'usage', usage: assistant.usage });

    if (lastCall || !assistant.tool_calls?.length) {
      // Hand the client the exact turns we appended -- including tool calls
      // and results -- so the next request replays an identical prefix.
      emit({ type: 'done', messages: appended });
      return appended;
    }

    for (const call of assistant.tool_calls) {
      let args = {};
      try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; }
      catch { /* model emitted malformed JSON; the tool error will say so */ }
      emit({ type: 'tool_call', id: call.id, name: call.function.name, args });
      const result = await hub.call(call.function.name, args, toolCtx);
      emit({ type: 'tool_result', id: call.id, name: call.function.name, result });

      const text = String(result);
      // Every tool result becomes an artifact, whatever tool produced it. This
      // is the one thing that makes compaction possible later: content can only
      // leave the window safely if the stub left behind can bring it back.
      const artifactId = store.addArtifact(chatId, {
        toolName: call.function.name, args, content: text
      });
      const msg = { role: 'tool', tool_call_id: call.id, content: text, artifact_id: artifactId };
      // Safety valve for a single oversized result. Stubbing on arrival is an
      // append, not a rewrite, so it costs no cache -- unlike an epoch, which
      // is why the threshold sits high and this only catches the extremes.
      const cap = cfg.maxInlineChars || 0;
      if (cap > 0 && text.length > cap) {
        msg.stub_text = digest({ id: artifactId, tool_name: call.function.name, content: text });
      }

      working.push(toWire(msg));
      appended.push(msg.stub_text ? { ...msg, compacted: true } : msg);
      store.addMessage(chatId, msg);
    }
  }

  emit({ type: 'done', messages: appended });
  return appended;
}
