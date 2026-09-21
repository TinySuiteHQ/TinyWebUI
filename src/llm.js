import { toWire } from './store.js';
import { digest, planEpoch, applyEpoch, estimateTokens } from './compact.js';

// Appended only to the final request, never to the stored conversation, so the
// cached prefix is untouched and the next turn does not inherit it.
const BUDGET_SPENT = {
  role: 'system',
  content: [
    'The tool budget for this message is spent. No further tool calls are possible.',
    'Answer now using only what you have already gathered. State plainly what you could',
    'not determine and what would have been needed to determine it.'
  ].join(' ')
};

/**
 * Cache capabilities vary by model *and* gateway.
 *
 * - Claude/Nova use Anthropic-style explicit content breakpoints as the
 *   portable baseline.
 * - OpenRouter additionally supports Claude automatic caching via a top-level
 *   cache_control field. That becomes the preferred rolling strategy because
 *   it advances over client tool results during an agentic loop. Explicit
 *   markers are the fallback when automatic mode cannot be used.
 * - OpenRouter's Qwen and Gemini adapters accept the same explicit content
 *   breakpoint shape. Other providers with implicit caching need no marker.
 */
function isOpenRouter(cfg) {
  return /^https?:\/\/(?:[^/]+\.)?openrouter\.ai(?::\d+)?(?:\/|$)/i.test(cfg.baseUrl || '');
}

function isClaude(model) {
  return /claude|anthropic/i.test(model || '');
}

function isExplicitAlibabaCache(model) {
  return /^(?:deepseek\/deepseek-v3\.2|qwen\/(?:qwen3-max|qwen-plus|qwen3\.6-plus|qwen3-coder-plus|qwen3-coder-flash))(?::|$)/i
    .test(model || '');
}

function wantsBreakpoints(cfg) {
  const model = cfg.model || '';
  if (/claude|anthropic|amazon\.nova|nova-(lite|micro|pro|premier)/i.test(model)) return true;
  if (!isOpenRouter(cfg)) return false;
  return isExplicitAlibabaCache(model) || /gemini/i.test(model);
}

function cacheDirective(cfg) {
  const directive = { type: 'ephemeral' };
  if (isClaude(cfg.model) && cfg.cacheTtl === '1h') directive.ttl = '1h';
  return directive;
}

function wantsAutomaticClaude(cfg) {
  const provider = cfg.extraBody?.provider;
  const explicitlyRouted = provider && Object.keys(provider).length > 0;
  return Boolean(cfg.cache && isClaude(cfg.model) && isOpenRouter(cfg) && !explicitlyRouted);
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

export function buildMessages(cfg, history, epochIndex = -1) {
  // OpenRouter Claude automatic caching is the rolling strategy itself. Do not
  // stack explicit breakpoints on top unless automatic mode is unavailable.
  const bp = cfg.cache && wantsBreakpoints(cfg) && !wantsAutomaticClaude(cfg);
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
export function buildBody(cfg, { turn, tools, lastCall, epochIndex, chatId }, disabled) {
  const body = {
    // Gateway-specific routing/knobs first, so nothing below can be clobbered.
    ...(cfg.extraBody || {}),
    model: cfg.model,
    messages: buildMessages(
      disabled.has('cache') ? { ...cfg, cache: false } : cfg, turn, epochIndex
    ),
    stream: true
  };

  // OpenRouter's explicit session key makes provider stickiness start after the
  // first successful request, before a cache hit has happened. Respect an
  // explicit caller override in extraBody, otherwise use the conversation id.
  if (isOpenRouter(cfg) && chatId && body.session_id == null) {
    body.session_id = String(chatId).slice(0, 256);
  }

  // Claude automatic caching advances the breakpoint to the last cacheable
  // block as the conversation grows. This is the piece that covers client tool
  // results between MCP rounds; the explicit markers above remain as the
  // portable fallback for Bedrock/Vertex-style routes and other gateways.
  if (!disabled.has('cache') && wantsAutomaticClaude(cfg)) {
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
 * POSTs the completion, and if the gateway rejects it over one of the optional
 * knobs, drops that knob and retries. `disabled` is shared across the whole turn,
 * so we learn an endpoint's limits once rather than re-probing every round.
 */
async function post(cfg, plan, signal, disabled, emit) {
  for (let attempt = 0; attempt <= OPTIONAL.length; attempt++) {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
        'http-referer': 'https://github.com/TinySuiteHQ/tinywebui',
        'x-title': 'TinyWebUI'
      },
      body: JSON.stringify(buildBody(cfg, plan, disabled))
    });
    if (res.ok && res.body) return res;

    const text = await res.text();
    const culprit = res.status >= 400 && res.status < 500
      ? OPTIONAL.find((o) => !disabled.has(o.drop) && o.probe.test(text))
      : null;
    if (!culprit) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`);

    disabled.add(culprit.drop);
    emit({ type: 'notice', text: `Provider rejected ${culprit.drop}; retrying without it.` });
  }
  throw new Error('Request rejected after dropping every optional field.');
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
    const turn = lastCall ? [...working, BUDGET_SPENT] : working;

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

    for await (const chunk of streamChunks(res)) {
      if (chunk.usage) usage = chunk.usage;
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
    if (usage) assistant.usage = usage;
    working.push(assistant);
    appended.push(assistant);
    store.addMessage(chatId, assistant);
    if (usage) emit({ type: 'usage', usage });

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
