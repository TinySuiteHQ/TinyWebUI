/**
 * The transcript as data: every stream event folds into one model, and a
 * stored history is turned into the very same events first, so a reopened
 * chat and a live one are drawn from one code path and cannot disagree.
 *
 * Pure TypeScript with no Vue: the chat store wraps the model in reactivity,
 * and node:test runs this file as is (test/turn-model.test.ts).
 *
 * The design it draws: the answer is what streams; everything the agent did to
 * get there (reasoning, tool calls, narration between them, per-round usage)
 * is the turn's activity, shown as one quiet status line while it runs and
 * folded behind a row once there is an answer. What needs the person -- an
 * approval, a question -- is pending, and never hidden.
 */
import { EVENT, type EventType } from '../../../shared/events.ts';
import { ORIGIN } from '../../../shared/origins.ts';
import { splitAttachmentNotes } from '../../../shared/attachment_note.ts';
import type { RawUsage } from '../../../shared/usage.ts';
import { isDeclined } from '../../../shared/declined.ts';

export type Doc = { id: string, filename: string, char_len: number };
/** Freshly staged images carry `dataBase64`; replayed ones the stored `data`. */
export type Img = { filename?: string, mime: string, data?: string, dataBase64?: string };
export type QueueItem = { id: string, kind: string, content: string };
export type Task = { id?: string, title: string, status: string };
export type AutomationOrigin = { type: string, name?: string, trigger?: string, cron?: string, timezone?: string, prompt?: string };

export type ToolStep = {
  kind: 'tool', id: string, name: string,
  /** The arguments, pretty-printed: kept as text so the model holds no objects to proxy. */
  args: string,
  /** The first argument, one line: what the step is "on". */
  arg: string,
  result: string | null,
  error: boolean, compacted: boolean,
  /** running, waiting (for the person), done, denied, or how a question settled. */
  state: 'running' | 'waiting' | 'done' | 'denied' | 'no answer' | 'skipped' | 'stopped',
  startedAt: number | null, endedAt: number | null
};
export type Entry =
  | { kind: 'reasoning', id: string, text: string, startedAt: number | null, endedAt: number | null }
  | ToolStep
  | { kind: 'note', id: string, text: string }
  | { kind: 'usage', id: string, raw: RawUsage };

export type Approval = { kind: 'approval', callId: string, name: string };
export type Question = {
  kind: 'question', callId: string | null, qid: string, question: string,
  choices: string[], allowFreeText: boolean, deadline: number | null
};
export type Pending = Approval | Question;

export type Turn = {
  kind: 'turn', id: string,
  /** The one-line status while working; null once settled. */
  status: string | null,
  activity: Entry[],
  /** The candidate answer: the newest prose, until more work follows it. */
  answer: string,
  /** Where in the activity the candidate began, so a demoted one goes back where it was spoken. */
  answerAt: number,
  pending: Pending[],
  notices: string[], errors: string[],
  usage: RawUsage[],
  startedAt: number | null, finishedAt: number | null,
  done: boolean
};
export type UserItem = { kind: 'user', id: string, seq: number | null, text: string, docs: Doc[], images: Img[] };
export type Item =
  | UserItem
  | { kind: 'automation', id: string, seq: number | null, origin: AutomationOrigin }
  | Turn
  | { kind: 'error', id: string, text: string };

export type Model = {
  items: Item[],
  chat: { id: string | null, title: string },
  queue: QueueItem[],
  tasks: Task[] | null,
  /** Set by next_run: a queued follow-up started a run of its own. */
  nextRun: boolean,
  /** A replayed history has no timings worth showing. */
  replaying: boolean,
  // Where the stream is: the turn being drawn and its open thought.
  cur: Turn | null,
  thought: Extract<Entry, { kind: 'reasoning' }> | null,
  seq: number
};

// Loose by nature: events come off the wire as parsed JSON.
export type StreamEvent = { type: string, [field: string]: any };

export function createModel(chat: { id: string | null, title: string } = { id: null, title: 'New chat' }): Model {
  return { items: [], chat: { ...chat }, queue: [], tasks: null, nextRun: false, replaying: false, cur: null, thought: null, seq: 0 };
}

const nextId = (m: Model, prefix: string) => `${prefix}${++m.seq}`;
const short = (name: string) => name.replace(/^[^_]+__/, '');

function firstArg(args: unknown): string {
  const first = args && typeof args === 'object' ? Object.values(args)[0] : undefined;
  if (first == null) return '';
  return String(typeof first === 'object' ? JSON.stringify(first) : first);
}

/**
 * The status line for a tool call: a plain verb when the tool's name says
 * what it does, else the tool's own name. Only ever set from a real event.
 */
export function statusOf(name: string, args?: unknown): string {
  const n = short(name);
  if (n === 'ask_user') return 'Waiting for your answer';
  if (/search_chats/.test(n)) return 'Searching your chats…';
  if (/search|query|find|lookup/i.test(n)) return 'Searching…';
  if (/read_document|read|fetch|browse|open|get_/i.test(n)) {
    const arg = firstArg(args);
    return arg && arg.length < 60 && !/^\{/.test(arg) ? `Reading ${arg}…` : 'Reading…';
  }
  if (/memory|remember|recall/i.test(n)) return 'Checking memory…';
  if (/task/i.test(n)) return 'Planning…';
  return `Using ${n}…`;
}

function startTurn(m: Model, now: number): Turn {
  const turn: Turn = {
    kind: 'turn', id: nextId(m, 't'), status: 'Thinking…', activity: [], answer: '', answerAt: 0, pending: [],
    notices: [], errors: [], usage: [], startedAt: m.replaying ? null : now, finishedAt: null, done: false
  };
  m.items.push(turn);
  m.cur = turn;
  return turn;
}

/** The turn events land in, started on demand. */
const turnOf = (m: Model, now: number) => m.cur ?? startTurn(m, now);

/** Closes the open thought, if any, timing it. */
function endThought(m: Model, now: number) {
  if (!m.thought) return;
  if (!m.replaying) m.thought.endedAt = now;
  // A thought that never said anything (some providers open one empty) is noise.
  if (!m.thought.text.trim() && m.cur) m.cur.activity = m.cur.activity.filter((e) => e !== m.thought);
  m.thought = null;
}

/**
 * Something followed the candidate answer, so it was narration, not the
 * answer: it joins the activity in the order it was spoken.
 */
function demote(m: Model, turn: Turn) {
  if (!turn.answer.trim()) { turn.answer = ''; return; }
  // Usage for the round that spoke it can land after the prose; the note goes
  // back to where the prose began, not after it.
  turn.activity.splice(turn.answerAt, 0, { kind: 'note', id: nextId(m, 'n'), text: turn.answer });
  turn.answer = '';
}


function step(turn: Turn, id: string): ToolStep | undefined {
  for (const e of turn.activity) if (e.kind === 'tool' && e.id === id) return e;
  return undefined;
}

/** Settles the current turn: no more status, no more waiting. */
export function finishTurn(m: Model, now = Date.now()) {
  endThought(m, now);
  const turn = m.cur;
  if (!turn) return;
  turn.status = null;
  turn.done = true;
  turn.pending = [];
  if (!m.replaying) turn.finishedAt = now;
  // A step still marked running when its turn ended (stopped, failed) is not.
  for (const e of turn.activity) if (e.kind === 'tool' && (e.state === 'running' || e.state === 'waiting')) e.state = 'stopped';
  // A turn opened in anticipation (a send, a rejoin) that nothing landed in
  // leaves no trace: a follow-up's user message may have closed it at once.
  if (!turn.activity.length && !turn.answer && !turn.notices.length && !turn.errors.length) m.items = m.items.filter((i) => i !== turn);
  m.cur = null;
}

/** Opens the turn the next events land in, so the status line shows before the first one does. */
export function beginTurn(m: Model, now = Date.now()): Turn {
  finishTurn(m, now);
  return startTurn(m, now);
}

/** An error with no turn to belong to (opening a chat failed, a send was refused). */
export function addError(m: Model, text: string) {
  if (m.cur) m.cur.errors.push(text);
  else m.items.push({ kind: 'error', id: nextId(m, 'e'), text });
}

/** The question the person sent, drawn before the server has answered anything. */
export function addUser(m: Model, text: string, seq: number | null = null, docs: Doc[] = [], images: Img[] = []) {
  m.items.push({ kind: 'user', id: nextId(m, 'u'), seq, text, docs, images });
}

type Handler = (m: Model, ev: StreamEvent, now: number) => void;

// Typed against every event name, so a new EVENT does not compile until it is handled here.
const HANDLERS: Record<EventType, Handler> = {
  [EVENT.CHAT]: (m, ev) => { m.chat = { id: ev.id, title: ev.title }; },
  [EVENT.USER]: (m, ev, now) => {
    // Queued input delivered into this run (steering) or starting the next one
    // (a follow-up): the turn so far closes above it. A replayed history
    // carries the stored message's own seq, documents and images.
    finishTurn(m, now);
    if (ev.origin?.type === ORIGIN.AUTOMATION) m.items.push({ kind: 'automation', id: nextId(m, 'a'), seq: ev.seq ?? null, origin: ev.origin });
    else addUser(m, String(ev.content ?? ''), ev.seq ?? null, ev.docs ?? [], ev.images ?? []);
  },
  [EVENT.QUEUE]: (m, ev) => { m.queue = ev.items || []; },
  [EVENT.NEXT_RUN]: (m) => { m.nextRun = true; },
  [EVENT.REASONING]: (m, ev, now) => {
    const turn = turnOf(m, now);
    // A fresh thought starts the next round: whatever prose stood was narration.
    if (!m.thought) {
      demote(m, turn);
      m.thought = { kind: 'reasoning', id: nextId(m, 'r'), text: '', startedAt: m.replaying ? null : now, endedAt: null };
      turn.activity.push(m.thought);
    }
    m.thought.text += ev.delta ?? '';
    if (!turn.answer) turn.status = 'Thinking…';
  },
  [EVENT.TEXT]: (m, ev, now) => {
    const turn = turnOf(m, now);
    endThought(m, now);
    if (!turn.answer) turn.answerAt = turn.activity.length;
    turn.answer += ev.delta ?? '';
    if (turn.answer.trim()) turn.status = 'Writing…';
  },
  [EVENT.TOOL_CALL]: (m, ev, now) => {
    const turn = turnOf(m, now);
    endThought(m, now);
    demote(m, turn);
    turn.activity.push({
      kind: 'tool', id: ev.id, name: ev.name, args: JSON.stringify(ev.args ?? {}, null, 2), arg: firstArg(ev.args),
      result: null, error: false, compacted: false, state: 'running', startedAt: m.replaying ? null : now, endedAt: null
    });
    turn.status = statusOf(ev.name, ev.args);
  },
  [EVENT.TOOL_RESULT]: (m, ev, now) => {
    const s = m.cur && step(m.cur, ev.id);
    if (!s) return;
    s.result = String(ev.result ?? '');
    s.error = /^Error/.test(s.result);
    s.compacted = Boolean(ev.compacted);
    // A declined call is recognised by the result the server writes for it, so
    // a reopened chat (which keeps no approval events) says so too.
    if (isDeclined(s.result)) s.state = 'denied';
    else if (s.state === 'running' || s.state === 'waiting' || s.state === 'denied') s.state = 'done';
    if (!m.replaying) s.endedAt = now;
    if (m.cur && !m.cur.answer) m.cur.status = 'Thinking…';
  },
  [EVENT.APPROVAL]: (m, ev, now) => {
    const turn = turnOf(m, now);
    const s = step(turn, ev.id);
    if (s) s.state = 'waiting';
    if (!turn.pending.some((p) => p.kind === 'approval' && p.callId === ev.id)) {
      turn.pending.push({ kind: 'approval', callId: ev.id, name: ev.name || s?.name || '' });
    }
    turn.status = 'Waiting for your approval';
  },
  [EVENT.APPROVAL_DONE]: (m, ev, now) => {
    const turn = m.cur;
    if (!turn) return;
    turn.pending = turn.pending.filter((p) => !(p.kind === 'approval' && p.callId === ev.id));
    const s = step(turn, ev.id);
    if (s) {
      s.state = ev.decision === 'deny' ? 'denied' : 'running';
      // The clock restarts: the wait for the person is not the tool's time.
      if (!m.replaying) s.startedAt = now;
    }
    turn.status = s ? statusOf(s.name, {}) : 'Thinking…';
  },
  [EVENT.QUESTION]: (m, ev, now) => {
    const turn = turnOf(m, now);
    // The question carries its own id, not the tool call's: it belongs to the
    // ask_user call still running (calls that ask are sequential).
    const ask = [...turn.activity].reverse().find((e): e is ToolStep => e.kind === 'tool' && short(e.name) === 'ask_user' && e.state === 'running');
    if (ask) ask.state = 'waiting';
    if (!turn.pending.some((p) => p.kind === 'question' && p.qid === ev.id)) {
      turn.pending.push({
        kind: 'question', callId: ask?.id ?? null, qid: ev.id, question: String(ev.question ?? ''),
        choices: ev.choices || [], allowFreeText: Boolean(ev.allowFreeText), deadline: ev.deadline ?? null
      });
    }
    turn.status = 'Waiting for your answer';
  },
  [EVENT.QUESTION_DONE]: (m, ev) => {
    const turn = m.cur;
    if (!turn) return;
    const q = turn.pending.find((p): p is Question => p.kind === 'question' && p.qid === ev.id);
    turn.pending = turn.pending.filter((p) => p !== q);
    const s = q?.callId ? step(turn, q.callId) : undefined;
    if (s) s.state = ({ timeout: 'no answer', skipped: 'skipped', cancelled: 'stopped' } as const)[ev.status as string] ?? 'running';
    turn.status = 'Thinking…';
  },
  [EVENT.TASKS]: (m, ev) => { m.tasks = ev.tasks || []; },
  // Drawn by the notice that accompanies it.
  [EVENT.COMPACTED]: () => {},
  [EVENT.USAGE]: (m, ev, now) => {
    const turn = turnOf(m, now);
    turn.usage.push(ev.usage);
    turn.activity.push({ kind: 'usage', id: nextId(m, 'g'), raw: ev.usage });
  },
  [EVENT.NOTICE]: (m, ev, now) => {
    const turn = turnOf(m, now);
    endThought(m, now);
    demote(m, turn);
    turn.notices.push(String(ev.text ?? ''));
  },
  [EVENT.ERROR]: (m, ev, now) => { turnOf(m, now).errors.push(String(ev.error ?? 'failed')); },
  // The server already has the messages; the stream's end settles the turn.
  [EVENT.DONE]: () => {}
};

export function applyEvent(m: Model, ev: StreamEvent, now = Date.now()) {
  const handle = HANDLERS[ev.type as EventType];
  if (handle) handle(m, ev, now);
}

/** A stored message, as /api/chats/:id returns it. */
export type StoredMessage = {
  role: string, content?: string | null, seq?: number, reasoning?: string | null,
  tool_calls?: { id: string, function: { name: string, arguments?: string } }[],
  tool_call_id?: string, usage?: RawUsage | null, compacted?: boolean,
  images?: Img[], origin?: AutomationOrigin | null
};

/**
 * A stored history, as the events a live stream would have sent for it. User
 * messages carry what the live event does not: their seq (for edit and
 * retry), and documents and images as chips.
 */
export function historyToEvents(messages: StoredMessage[], documents: Doc[] = []): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (msg.origin?.type === ORIGIN.AUTOMATION) { out.push({ type: EVENT.USER, origin: msg.origin, seq: msg.seq ?? null }); continue; }
      // The stored text carries the model's "[Attached document ...]" notes;
      // the page shows them as chips, and edit needs them as such to drop one.
      const { text, ids } = splitAttachmentNotes(msg.content);
      const docs = ids.map((id) => documents.find((d) => d.id === id)).filter((d): d is Doc => Boolean(d));
      out.push({ type: EVENT.USER, content: text, seq: msg.seq ?? null, docs, images: msg.images || [] });
    } else if (msg.role === 'assistant') {
      if (msg.reasoning) out.push({ type: EVENT.REASONING, delta: msg.reasoning });
      // A whitespace-only content string rides alongside tool_calls on some
      // backends (DeepSeek/CoreWeave); it is not prose.
      const prose = msg.content?.trim() ? msg.content : '';
      if (prose && msg.tool_calls?.length) out.push({ type: EVENT.TEXT, delta: prose });
      for (const tc of msg.tool_calls || []) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* keep {} */ }
        out.push({ type: EVENT.TOOL_CALL, id: tc.id, name: tc.function.name, args });
      }
      if (prose && !msg.tool_calls?.length) out.push({ type: EVENT.TEXT, delta: prose });
      // Per-round usage is stored on the message, so a reopened chat still
      // shows what each round cost.
      if (msg.usage) out.push({ type: EVENT.USAGE, usage: msg.usage });
    } else if (msg.role === 'tool') {
      out.push({ type: EVENT.TOOL_RESULT, id: msg.tool_call_id, result: msg.content ?? '', compacted: Boolean(msg.compacted) });
    }
  }
  return out;
}

/** Rebuilds the model of a stored chat. Its last turn is left open when `running`: the live stream continues it. */
export function replay(m: Model, messages: StoredMessage[], documents: Doc[] = []) {
  m.replaying = true;
  for (const ev of historyToEvents(messages, documents)) applyEvent(m, ev);
  finishTurn(m);
  m.replaying = false;
}

/* ---------- history actions: what they touch, and the handles they need ---------- */

/** What a stretch of the transcript holds, for saying what an action would remove or copy. */
export type Tally = { questions: number, answers: number, toolCalls: number, documents: number, images: number };

export function tally(items: readonly Item[]): Tally {
  const out: Tally = { questions: 0, answers: 0, toolCalls: 0, documents: 0, images: 0 };
  const docs = new Set<string>();
  for (const it of items) {
    if (it.kind === 'user') {
      out.questions++;
      for (const d of it.docs) docs.add(d.id);
      out.images += it.images.length;
    } else if (it.kind === 'automation') out.questions++;
    else if (it.kind === 'turn') {
      if (it.answer) out.answers++;
      out.toolCalls += it.activity.filter((e) => e.kind === 'tool').length;
    }
  }
  out.documents = docs.size;
  return out;
}

/**
 * The stored seq of the question each item belongs to, by item id: a question
 * is its own, a turn answers the question above it. Null where it is not yet
 * known (drawn from a live stream, before adoptSeqs).
 */
export function questionSeqs(m: Model): Map<string, number | null> {
  const out = new Map<string, number | null>();
  let current: number | null = null;
  for (const it of m.items) {
    if (it.kind === 'user' || it.kind === 'automation') current = it.seq;
    out.set(it.id, current);
  }
  return out;
}

/**
 * Gives a view drawn from a live stream the seqs its questions were stored
 * at (GET /api/chats/:id/questions), in order. False, changing nothing, when
 * the two disagree on how many there are: the view should then be redrawn
 * from the store instead.
 */
export function adoptSeqs(m: Model, seqs: readonly number[]): boolean {
  const asked = m.items.filter((it): it is Extract<Item, { kind: 'user' | 'automation' }> => it.kind === 'user' || it.kind === 'automation');
  if (asked.length !== seqs.length) return false;
  asked.forEach((it, i) => { it.seq = seqs[i]; });
  return true;
}
