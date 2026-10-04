import { createHash } from 'node:crypto';
import { attributeRequest, completeAttribution, markFinal } from '../harness/attribution.js';
import { toWire, AUX_KIND } from '../store/index.js';
import { toolExecutor } from './tool_executor.js';
import { ASK_USER } from '../tools/ask_tool.js';
import { openTasksNote } from '../tools/task_tool.js';
import { runAgentLoop, runHooks } from '../harness/agent.js';
import { repairToolHistory } from '../harness/history.js';
import { checkpointSource, checkpointSection, summarize } from '../harness/checkpoint.js';
import { harnessBlock, budgetFooter } from '../harness/prompt.js';
import { isOpenRouter, post, streamChunks, retryDelay, sleep, STREAM_RETRIES, StreamError } from '../harness/provider.js';
import { EVENT } from '../../public/shared/events.js';
import {
  digest, planEpoch, applyEpoch, planWindow, windowRows, estimateTokens, estimateToolTokens
} from './compact.js';

/**
 * How much of the next prompt is conversation history -- the only part
 * compaction can shrink, and so the only part the threshold should measure.
 *
 * The provider's own count of the last request is the best number we have, but
 * it needs two corrections. It includes the system prompt and the tool block,
 * which on a setup with a few MCP servers can be tens of thousands of tokens by
 * itself; counting that against the threshold starts an epoch (a full cache
 * miss) on nearly every turn while saving next to nothing. And it counts
 * results that were stubbed on arrival at full size, because the turn that
 * fetched them sent them whole -- the next request sends the stub instead.
 */
function historyTokens(rows, cfg, tools) {
  const last = rows.findLastIndex((r) => r.usage_json);
  const reported = last >= 0 ? JSON.parse(rows[last].usage_json).prompt_tokens : 0;
  // Providers disagree about reporting usage and some report none at all, so
  // fall back to a size estimate rather than never compacting.
  if (!reported) return estimateTokens(rows.map(toWire));

  const overhead = estimateTokens([{ content: cfg.systemPrompt }]) + estimateToolTokens(tools);
  let turnStart = last;
  while (turnStart > 0 && rows[turnStart].role !== 'user') turnStart--;
  let shrunk = 0;
  for (let i = turnStart; i < last; i++) {
    const r = rows[i];
    if (r.role === 'tool' && r.stub_text) shrunk += (r.content?.length ?? 0) - r.stub_text.length;
  }
  return Math.max(0, reported - overhead - Math.ceil(shrunk / 4));
}

/**
 * Whether the previous turn left a result that was sent whole then but goes
 * out as its stub from now on (the `maxInlineChars` case). Results past
 * `maxTurnChars` were already sent as stubs, so they change nothing.
 */
export function swapsStubThisTurn(rows, cfg) {
  const users = rows.map((r, i) => (r.role === 'user' ? i : -1)).filter((i) => i >= 0);
  if (users.length < 2) return false;
  const turnCap = cfg.maxTurnChars || 0;
  return rows.slice(users[users.length - 2], users[users.length - 1]).some((r) =>
    r.role === 'tool' && r.stub_text && !(turnCap > 0 && (r.content?.length ?? 0) > turnCap));
}

/**
 * One chat turn: decides compaction and the hard window up front, then drives
 * the generic loop in agent.js with TinyWebUI's runtime -- the provider stream,
 * the tool policy, and persistence. `emit(event)` is called for every UI event.
 * Returns the messages appended to the conversation.
 */
export async function runChat({
  cfg, chatId, store, tools, hub, emit, signal, historyFromSeq = null, unattended = false,
  // (call) => Promise<'allow' | 'always' | 'deny'>. Asked for each call the
  // approval policy stops; without it such calls are declined, never run.
  approve = null,
  // Extra lifecycle hooks (see agent.js), run after the built-in ones.
  hooks = {},
  // () => string[]: steering input queued while this run works, taken at each
  // safe boundary. Persisted and shown as ordinary user messages.
  takeInput = null,
  // ({ question, choices, allowFreeText }) => Promise<{ answered, answer? , reason? }>:
  // puts an ask_user question to the user. Absent on unattended runs.
  askUser = null
}) {
  const maxRounds = Math.max(1, cfg.maxToolRounds || 12);
  const operatorPrompt = cfg.systemPrompt;

  // Built once per turn, so every round of it sends the same system bytes.
  // Server-level MCP guidance (call order, when to prefer one tool over
  // another) rides along after the harness block.
  const instructions = hub?.instructionsBlock?.();
  const harness = harnessBlock({
    maxRounds, hasTools: tools.length > 0, timeZone: cfg.timezone,
    canAsk: tools.some((t) => t.function?.name === ASK_USER)
  });
  const owner = (name) => hub?.routes?.get(name)?.server || 'built-ins';

  // Optional request fields this endpoint has already refused, learned once.
  const disabled = new Set();

  // Automation executions remain ordinary, visible chat turns, but do not
  // inherit the conversation that happened before the automation was created.
  // The boundary is captured at launch so subsequent rounds still include all
  // messages generated by this execution.
  // One loader for every (re)read, so a reload after compaction can't drop the
  // automation boundary or the hard window.
  const scopeStart = Number.isSafeInteger(historyFromSeq) ? historyFromSeq : null;
  const scoped = () => {
    const all = store.messages.list(chatId);
    return scopeStart == null ? all : all.filter((row) => row.seq >= scopeStart);
  };
  // A checkpoint written under another history boundary (an automation run
  // in the same chat, or the chat itself) summarises messages this run must
  // not see, so it only counts when the boundary matches.
  const checkpoint = () => {
    const raw = store.chats.byId(chatId).checkpoint_json;
    const cp = raw ? JSON.parse(raw) : null;
    return cp && cp.scopeStart === scopeStart ? cp : null;
  };
  const load = () => windowRows(scoped(), store.chats.byId(chatId).window_seq, { summarized: Boolean(checkpoint()) });
  let rows = load();
  const chat = store.chats.byId(chatId);
  const keepTurns = Math.max(1, cfg.keepTurns || 2);

  // Compaction is decided once, here, before the first request of the turn --
  // never between rounds. Within a turn the prefix may only grow, so a round
  // can always read back what the previous round wrote to the cache.
  // A result stubbed for later turns only flips to its stub now, so this
  // request is cold from that message on whatever we do. An epoch opened now
  // rides on that miss for free instead of costing its own later.
  const stubSwap = swapsStubThisTurn(rows, cfg);
  const threshold = cfg.compactThreshold || 0;
  if (threshold > 0) {
    const plan = planEpoch(rows, {
      threshold,
      keepTurns,
      promptTokens: stubSwap ? Infinity : historyTokens(rows, cfg, tools)
    });
    const done = plan && applyEpoch(store, chat, plan, { minSaved: cfg.compactMinSaved || 0 });
    if (done) {
      rows = load();
      emit({
        type: EVENT.NOTICE,
        text: `Context compacted (epoch ${done.epoch}): ${done.saved.toLocaleString('en-US')} chars of earlier tool output and images moved out of the window. Use expand_context to read any of it.`
      });
      emit({ type: EVENT.COMPACTED, epoch: done.epoch, boundarySeq: done.boundarySeq, saved: done.saved });
    }
  }

  // The hard window, for when stubbing is not enough: a long conversation of
  // plain text has nothing for an epoch to shrink. Checked after the epoch so
  // it only ever moves when compaction has already done what it can.
  const maxHistory = cfg.maxHistoryTokens || 0;
  const cut = planWindow(rows, {
    maxTokens: maxHistory, targetTokens: Math.floor(maxHistory / 2), keepTurns, toWire
  });
  if (cut != null) {
    const before = rows.length;
    const summary = cfg.llmCompaction
      ? await summarizeDropped({ cfg, store, chatId, emit, signal, previous: checkpoint(),
        dropped: scoped().filter((r) => r.seq >= (rows[0]?.seq ?? 0) && r.seq < cut) })
      : null;
    // One statement, so a checkpoint is never stored against the wrong window.
    store.chats.touch(chatId, summary
      ? { window_seq: cut, checkpoint_json: JSON.stringify({ summary, throughSeq: cut - 1, scopeStart, model: cfg.model }) }
      : { window_seq: cut });
    rows = load();
    emit({
      type: EVENT.NOTICE,
      text: `Context window full: the ${before - rows.length} oldest messages are no longer sent to the model (they stay in the transcript)`
        + (summary ? ' and are summarised for it instead.' : '.')
    });
  }

  // Built once per turn, after the window, so every round of it sends the same
  // system bytes and a checkpoint only changes them when the window moves --
  // a cold request anyway. Kept apart so Statistics can say which part of the
  // system prompt costs what.
  const cp = checkpoint();
  const systemParts = [
    { category: 'operator', text: operatorPrompt },
    { category: 'harness', text: harness },
    { category: 'mcp_instructions', text: instructions },
    { category: 'checkpoint', text: cp ? checkpointSection(cp.summary) : '' }
  ];
  cfg = { ...cfg, systemPrompt: systemParts.map((p) => p.text).filter(Boolean).join('\n\n') };

  // Index of the last message inside the frozen prefix, for the pinned
  // breakpoint. -1 before the first epoch, when there is nothing frozen yet.
  const boundarySeq = store.chats.byId(chatId).boundary_seq;
  // Reasoning behind the frozen boundary goes too. Providers only need it
  // echoed within the turn that made it, and the boundary moves only at an
  // epoch, which is a cold request anyway -- so dropping it never costs cache.
  const seqOf = new Map();
  const working = repairToolHistory(rows.map((r) => {
    const w = toWire(r);
    if (boundarySeq >= 0 && r.seq < boundarySeq) { delete w.reasoning_details; delete w.reasoning; }
    seqOf.set(w, r.seq);
    return w;
  }));
  // Found by seq, not row index: a repair can add or drop messages before it.
  const epochIndex = boundarySeq >= 0
    ? working.findIndex((w) => seqOf.get(w) >= boundarySeq) - 1
    : -1;

  const tools_ = toolExecutor({ cfg, chatId, store, hub, emit, unattended, approve, askUser, footer: (round) => budgetFooter(round, maxRounds) + openTasksNote(store.chats.listTasks(chatId)), hooks, signal });
  const saved = [];
  const appended = await runAgentLoop({
    messages: working,
    maxRounds,
    signal,
    runtime: {
      onEvent: emit,
      streamTurn: ({ messages, lastCall }) => streamTurn({
        cfg, chatId, store, emit, signal, disabled, tools, epochIndex, messages, lastCall, stubSwap,
        attributionContext: { systemParts, owner },
        onSaved: (assistant, seq) => saved.push({ assistant, seq })
      }),
      executeToolBatch: tools_.execute,
      pendingInput: takeInput && (async () => (await takeInput()).map((content) => {
        const msg = { role: 'user', content };
        store.messages.add(chatId, msg);
        emit({ type: EVENT.USER, content });
        return { wire: msg, message: msg };
      })),
      shouldContinue: async ({ round, assistant, results }) => {
        if (tools_.stopRequested()) return false;
        try {
          return !(await runHooks(hooks.afterTurn, { round, assistant, results, signal }, (o) => o.stop));
        } catch (err) {
          if (signal?.aborted) throw err;
          // Stopping is the one outcome that cannot leave the transcript
          // half-built: the batch is complete, and no model call is pending.
          emit({ type: EVENT.NOTICE, text: `Turn hook failed (${err.message}) — stopping here.` });
          return false;
        }
      }
    }
  });
  // Hand the client the exact turns we appended -- including tool calls
  // and results -- so the next request replays an identical prefix.
  // The last reply is only known to be the answer once the run has ended.
  const final = saved.at(-1);
  if (final && !final.assistant.tool_calls?.length && !signal?.aborted) {
    final.assistant.usage.attribution = markFinal(final.assistant.usage.attribution);
    store.messages.updateUsage(chatId, final.seq, final.assistant.usage);
  }
  emit({ type: EVENT.DONE, messages: appended });
  return appended;
}

/**
 * One model request: posts it, streams the reply to the UI, and persists the
 * assistant message it assembles. The provider-specific half of a round.
 */
/**
 * A fingerprint of what one request asked the provider to cache, so a miss can
 * be pinned on us or on them. `chain[i]` hashes the tool block and messages
 * 0..i cumulatively, so two requests agree up to exactly the first message
 * whose bytes differ. `matched` is how many leading messages this request
 * shares byte-for-byte with the previous one in the same chat: a miss where
 * `matched` covers the whole previous request is the provider's, not ours.
 */
const lastChains = new Map();
// Only the chats a server is actively serving matter; the oldest go first.
const MAX_CHAINS = 200;

function rememberChain(chatId, chain) {
  lastChains.delete(chatId);
  lastChains.set(chatId, chain);
  if (lastChains.size > MAX_CHAINS) lastChains.delete(lastChains.keys().next().value);
}

export function prefixFingerprint(body, previous) {
  const h = createHash('sha256');
  h.update(JSON.stringify(body.tools || []));
  const tools = h.copy().digest('hex').slice(0, 8);
  const chain = body.messages.map((m) => {
    h.update(JSON.stringify(m));
    return h.copy().digest('hex').slice(0, 8);
  });
  let matched = 0;
  if (previous) while (matched < chain.length && chain[matched] === previous[matched]) matched++;
  return { tools, chain, matched, previous: previous ? previous.length : null };
}

async function streamTurn({ cfg, chatId, store, emit, signal, disabled, tools, epochIndex, messages, lastCall, stubSwap, attributionContext, onSaved }) {
  let input;
  let prefix;
  const request = () => post(cfg, { turn: messages, tools, lastCall, epochIndex, chatId,
    onRequest: (body) => {
      input = attributeRequest(body, attributionContext);
      prefix = prefixFingerprint(body, lastChains.get(chatId));
      // Marks a break we chose (see swapsStubThisTurn), so Statistics doesn't
      // report it as a prefix bug.
      if (stubSwap && prefix.previous != null && prefix.matched < prefix.previous) prefix.stubSwap = true;
      rememberChain(chatId, prefix.chain);
    }
  }, signal, disabled, emit);

  let content;
  let reasoning;
  let reasoningDetails;
  let toolCalls;
  let usage;
  // Which upstream actually served this round. A gateway that routes one
  // model across several providers gives each its own cache, so a round that
  // lands somewhere new misses in full however stable the prefix was --
  // indistinguishable from a prefix bug unless the provider is on the record.
  let provider;
  let finishReason;

  // post() retries until the first byte. This covers what happens after it:
  // a stream that breaks or reports an upstream error part-way. The round is
  // repeated only while no answer text has reached the user -- a half-sent
  // tool call has run nothing and is simply discarded -- and never stored.
  for (let attempt = 0; ; attempt++) {
    content = ''; reasoning = ''; reasoningDetails = []; toolCalls = [];
    usage = null; provider = null; finishReason = null;
    // post() has already spent its own retries on anything before the stream.
    const res = await request();
    try {
      for await (const chunk of streamChunks(res)) {
        if (chunk.usage) usage = chunk.usage;
        if (chunk.provider) provider = chunk.provider;
        // A failure after the 200 arrives in-band: an `error` object, or a choice
        // that finishes with reason "error". Either way the round did not happen.
        const finish = chunk.choices?.[0]?.finish_reason;
        if (chunk.error || finish === 'error') {
          throw new StreamError(chunk.error?.message || 'upstream error mid-stream');
        }
        if (finish) finishReason = finish;
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        // Reasoning is spelled differently per provider: `reasoning` on OpenRouter,
        // `reasoning_content` on DeepSeek/Qwen. Both are plain text deltas.
        const think = delta.reasoning ?? delta.reasoning_content;
        if (think) {
          reasoning += think;
          emit({ type: EVENT.REASONING, delta: think });
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
          emit({ type: EVENT.TEXT, delta: delta.content });
        }
        for (const tc of delta.tool_calls || []) {
          const slot = (toolCalls[tc.index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.function.name += tc.function.name;
          if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
        }
      }
      break;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (content || attempt >= STREAM_RETRIES) {
        throw new Error(`The model's reply broke off part-way (${err.message}).`
          + (content ? ' Retry to run this round again.' : ''));
      }
      emit({ type: EVENT.NOTICE, text: `Reply stream failed (${err.message}) — retrying the round (${attempt + 1}/${STREAM_RETRIES}).` });
      await sleep(retryDelay(null, attempt + 1), signal);
    }
  }

  // Cut off by the output cap: say so, or a truncated tool call just looks
  // like the model writing bad arguments.
  if (finishReason === 'length') {
    emit({ type: EVENT.NOTICE, text: 'The reply hit the output token limit and was cut off (raise maxTokens if this recurs).' });
  }

  // Dropped before anything is stored: nothing will produce their results.
  // Attribute generated output before dropping refused calls or inserting UI notices.
  const attribution = completeAttribution(input, usage, { content, reasoning,
    toolCalls: toolCalls.filter(Boolean), details: reasoningDetails.filter(Boolean) });
  if (lastCall) toolCalls.length = 0;

  // A reply with no text and no calls ends the turn with nothing to show --
  // most often the final pass on a provider that ignored tool_choice and
  // only tried to call more tools. Say so in the transcript rather than
  // leaving a blank bubble; stored like any answer, so the next turn's model
  // sees it too and knows the question went unanswered.
  if (!content.trim() && !toolCalls.some(Boolean)) {
    content = lastCall
      ? '(No answer: the tool budget ran out and the model replied without text. Ask again'
        + ' to have it answer from what it gathered, or raise maxToolRounds.)'
      : '(The model returned an empty reply.)';
    emit({ type: EVENT.TEXT, delta: content });
  }

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
  assistant.usage = {
    ...(usage || {}),
    attribution,
    ...(prefix ? { prefix } : {}),
    ...(provider ? { provider } : {}),
    ...(usage?.cost != null && isOpenRouter(cfg) && usage.cost_currency == null ? { cost_currency: 'USD' } : {})
  };
  // Snapshotted per-round rather than read back from config later -- the
  // model can change between chats (or mid-session), and usage history
  // should report what actually served the round, not whatever is current.
  assistant.model = cfg.model;
  const seq = store.messages.add(chatId, assistant);
  onSaved?.(assistant, seq);
  if (usage) emit({ type: EVENT.USAGE, usage: assistant.usage });
  return assistant;
}

/**
 * Summarises the rows a window move is about to drop, merged with the
 * previous checkpoint. Returns the summary, or null after a notice when it
 * could not be made: the window then moves as it always has, dropping them
 * unsummarised, rather than failing the user's turn.
 */
async function summarizeDropped({ cfg, store, chatId, emit, signal, previous, dropped }) {
  try {
    const { text } = await summarize({
      cfg, signal, emit,
      // Raw rows, not the wire form: full tool text (cut down in the source)
      // and the artifact ids a stub would hide.
      source: checkpointSource({ previous: previous?.summary, rows: dropped.map((r) => ({
        role: r.role, content: r.content, artifact_id: r.artifact_id,
        tool_calls: r.tool_calls_json ? JSON.parse(r.tool_calls_json) : undefined
      })) }),
      onUsage: (usage) => usage && store.usage.addAuxiliary(chatId, { kind: AUX_KIND.CHECKPOINT, model: cfg.model, usage })
    });
    return text;
  } catch (err) {
    if (signal?.aborted) throw err;
    emit({ type: EVENT.NOTICE, text: `Could not summarise the earlier conversation (${err.message}); it is dropped without a summary.` });
    return null;
  }
}
