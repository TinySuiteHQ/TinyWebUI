import { randomUUID } from 'node:crypto';
import { runChat } from './llm.ts';
import { effectiveConfig, findEntry, thinkingFor, usesTools } from '../config/models.ts';
import { roleSettingsFor } from '../access/policy.ts';
import { logger } from '../log.ts';
import { EVENT } from '../../shared/events.ts';
import { AUX_KIND, CORPUS, type Store } from '../store/index.ts';
import { writeTitle } from '../harness/title.ts';
import type { ChatRow, QuestionStatus } from '../store/chats.ts';
import type { UserRole } from '../store/users.ts';
import type { Config } from '../config/config.ts';
import type { McpHub } from '../mcp.ts';
import type { Retrieval } from '../retrieval/retrieval.ts';
import type { Emit, StreamEvent, ToolDef } from '../harness/types.ts';
import type { AskOutcome, AskRequest } from '../tools/types.ts';
import type { ApprovalDecision, Approve } from './tool_executor.ts';
import type { ServerResponse } from 'node:http';

const log = logger('retrieval');
const titleLog = logger('title');
/** How long a finished turn's stream waits for its title, so the page gets it in the same stream. */
const TITLE_WAIT_MS = 8000;

const RETAIN_MS = 5 * 60 * 1000;
// A turn can go quiet for minutes (a call waiting on approval, a slow tool),
// and proxies close a stream that idles past ~60 s. A comment line keeps it
// open; the page reads only `data:` frames, so it never sees one.
export const PING_MS = 20 * 1000;

/** The ask_user question a run is waiting on. */
export interface PendingQuestion {
  id: string;
  choices: string[];
  allowFreeText: boolean;
  /** True for the one caller that settled it. */
  settle(status: Exclude<QuestionStatus, 'pending'>, answer?: string | null): boolean;
}

/** One turn in flight; see createRuns. */
export interface Run {
  events: StreamEvent[];
  subs: Set<ServerResponse>;
  ac: AbortController;
  done: boolean;
  baseCount: number;
  approvals: Map<string, { name: string; resolve: (decision: ApprovalDecision) => void }>;
  question: PendingQuestion | null;
  unattended: boolean;
  emit: Emit;
}

export interface RunOptions {
  chat: ChatRow;
  tools: ToolDef[];
  onFinish?: (outcome: { ok: boolean; error: string | null; result: string }) => void;
  historyFromSeq?: number | null;
  unattended?: boolean;
  model?: string | null;
  lead?: string | null;
  instructions?: string | null;
  /** The role of the person the turn is for: its settings apply over the global and per-model ones. */
  role?: UserRole | null;
  /** The thinking level the person asked for; the model's own settings decide whether it applies. */
  thinking?: string | null;
  /** A new chat's first message: a title is asked for from it beside the turn (autoTitle). */
  titleFrom?: string | null;
}

/** The part of the app| null;
}

/** The part of the app a run reads live (built in server.js). */
export interface RunsApp {
  store: Store;
  cfg: Config;
  hub: McpHub;
  retrieval: Retrieval;
  onRunIdle(chatId: string): void;
}

export type Runs = ReturnType<typeof createRuns>;

/**
 * Turns in flight, by chat id.
 *
 * A turn used to live inside its HTTP response: the request's `close` event
 * aborted it, so closing the tab halfway through a twelve-round research run
 * threw the whole thing away, tokens already spent and all. A run is owned by
 * the server instead. The response is only a viewer -- it can come and go,
 * and more than one can watch at once.
 *
 * Every event is kept as well as broadcast, so a viewer that arrives late (a
 * reload, a second tab) replays what it missed from `from` and then follows
 * the rest live. The buffer is per-turn and dropped a few minutes after the
 * turn ends; the transcript itself lives in the store, as it always did.
 *
 * `app` supplies the live cfg and hub, the store and retrieval, and
 * `onRunIdle(chatId)`, called once a chat has nothing running.
 */
export function createRuns(app: RunsApp) {
  const { store } = app;
  const runs = new Map<string, Run>();

  const get = (chatId: string) => runs.get(chatId);
  const isRunning = (chatId: string) => {
    const run = runs.get(chatId);
    return Boolean(run && !run.done);
  };

  /** Tells everyone watching a chat's run what is queued now. */
  const announceQueue = (chatId: string) => runs.get(chatId)?.emit({ type: EVENT.QUEUE, items: store.chats.listQueued(chatId) });

  /**
   * `lead` is a queued follow-up that starts this run: stored after baseCount
   * and sent as an event, so a live view and a reload each show it once.
   */
  function start({ chat, tools, onFinish, historyFromSeq = null, unattended = false, model = null, lead = null, instructions = null, thinking = null, role = null, titleFrom = null }: RunOptions): Run {
    const run: Run = {
      events: [],
      subs: new Set(),
      ac: new AbortController(),
      done: false,
      // Where the store stood when the turn began, including the user message
      // that started it. A client reopening mid-turn replays up to here and
      // plays the events over the top.
      baseCount: store.messages.list(chat.id).length,
      // Tool calls waiting on the user, by call id -> { name, resolve }.
      approvals: new Map(),
      // The ask_user question waiting on the user: { id, settle }, or null.
      question: null,
      unattended,
      emit
    };
    runs.set(chat.id, run);
    // A stop settles every open question as "no", so the loop can unwind
    // instead of waiting forever on a prompt nobody will answer now.
    run.ac.signal.addEventListener('abort', () => {
      for (const { resolve } of run.approvals.values()) resolve('deny');
      run.approvals.clear();
      // Stop ends the run; the question is closed so no late answer revives it.
      run.question?.settle('cancelled');
    }, { once: true });
    // Unattended runs get no asker: the loop refuses gated calls itself.
    const approve: Approve | null = unattended ? null : ({ id, name }) =>
      new Promise((resolve) => run.approvals.set(id, { name, resolve }));

    /**
     * Puts one ask_user question to the user and waits: for an answer, a
     * skip, the timeout, or a stop. Persisted first, so the row decides who
     * settled it; the timer is read from the live config at ask time.
     */
    const askUser = unattended ? null : ({ question, choices, allowFreeText }: AskRequest): Promise<AskOutcome> => {
      if (run.ac.signal.aborted) return Promise.resolve({ answered: false, reason: 'cancelled' });
      // Calls are sequential, so a second one can only arrive after the first
      // settled; this is the guard should that ever change.
      if (run.question) return Promise.resolve({ answered: false, reason: 'busy' });
      const id = randomUUID();
      const seconds = Math.max(0, Number(roleSettingsFor(app.cfg, role).askUserTimeoutSeconds ?? app.cfg.askUserTimeoutSeconds) || 0);
      const deadline = seconds ? Date.now() + seconds * 1000 : null;
      store.chats.addQuestion(chat.id, { id, question, choices, allowFreeText, deadline });
      return new Promise((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const settle = (status: Exclude<QuestionStatus, 'pending'>, answer: string | null = null) => {
          if (!store.chats.settleQuestion(id, status, answer)) return false;
          clearTimeout(timer);
          if (run.question?.id === id) run.question = null;
          emit({ type: EVENT.QUESTION_DONE, id, status, answer });
          resolve(status === 'answered' ? { answered: true, answer: answer! } : { answered: false, reason: status });
          return true;
        };
        run.question = { id, choices, allowFreeText, settle };
        if (deadline) timer = setTimeout(() => settle('timeout'), seconds * 1000);
        emit({ type: EVENT.QUESTION, id, question, choices, allowFreeText, deadline, timeoutSeconds: seconds });
      });
    };

    function emit(event: StreamEvent) {
      run.events.push(event);
      for (const sub of run.subs) {
        try { sub.write(`data: ${JSON.stringify(event)}\n\n`); } catch { run.subs.delete(sub); }
      }
    }

    emit({ type: EVENT.CHAT, id: chat.id, title: chat.title });
    if (lead != null) {
      store.messages.add(chat.id, { role: 'user', content: lead });
      emit({ type: EVENT.USER, content: lead });
    }
    emit({ type: EVENT.QUEUE, items: store.chats.listQueued(chat.id) });

    // Steering is interactive input: an unattended run never takes any, so
    // it cannot swallow what someone typed into a chat an automation shares.
    const takeInput = unattended ? null : () => {
      const items = store.chats.takeQueued(chat.id, { kind: 'steer' });
      if (items.length) emit({ type: EVENT.QUEUE, items: store.chats.listQueued(chat.id) });
      return items.map((i) => i.content);
    };

    /**
     * A title from the first message, asked beside the turn so the answer never
     * waits on it. It replaces the stand-in title only if that is still the
     * title (a rename meanwhile wins), and reaches the page as a chat event.
     * Its notices are dropped: a title is not worth a line in the transcript.
     */
    function nameChat(cfg: Config, message: string): Promise<void> {
      const from = store.chats.byId(chat.id)?.title ?? chat.title;
      return writeTitle({
        cfg, message, emit: () => {}, signal: AbortSignal.timeout(60_000),
        onUsage: (usage) => { if (usage) store.usage.addAuxiliary(chat.id, { kind: AUX_KIND.TITLE, model: cfg.model, usage }); }
      }).then((title) => {
        if (title && store.chats.retitle(chat.id, from, title)) emit({ type: EVENT.CHAT, id: chat.id, title });
      }).catch((err) => titleLog.warn(`naming chat ${chat.id} failed: ${err.message}`));
    }
    let titling: Promise<void> | null = null;

    // Not awaited: the run outlives the request that started it.
    void (async () => {
      try {
        // Always sent when the model has a level. An endpoint that ignores it
        // answers as usual; one that rejects it has the field dropped for the
        // rest of this turn (post() in provider.ts). Nothing is remembered.
        const think = thinkingFor(app.cfg, model, thinking);
        // The role's settings for this model are looked up by its catalog id, which is how the role editor names it.
        const modelId = findEntry(app.cfg, model ?? app.cfg.model)?.id ?? model ?? app.cfg.model;
        const base = { ...effectiveConfig(app.cfg, model, roleSettingsFor(app.cfg, role, modelId)), thinkingLevel: think?.level ?? null, thinkingSend: think?.send };
        if (titleFrom?.trim() && base.autoTitle !== false) titling = nameChat(base, titleFrom);
        // Read now, not from the row the run started with: a chat moved into a
        // folder, or a folder's prompt edited, counts from the next turn on.
        // The folder's comes last, as the most specific of the three.
        const row = store.chats.byId(chat.id);
        const folderPrompt = row ? store.chats.folderPromptFor(row) : '';
        const cfg = { ...base, systemPrompt: [
          base.systemPrompt,
          instructions ? `The user's own instructions:\n${instructions}` : '',
          folderPrompt ? `This chat is in the user's folder "${row?.folder}". Instructions for the chats in it:\n${folderPrompt}` : ''
        ].filter(Boolean).join('\n\n') };
        // A model its admin set to no tools gets none, whatever the person's role allows.
        const offered = usesTools(findEntry(app.cfg, model ?? app.cfg.model)) ? tools : [];
        await runChat({ cfg, chatId: chat.id, store, tools: offered, hub: app.hub, emit, signal: run.ac.signal, historyFromSeq, unattended, approve, takeInput, askUser });
      } catch (err) {
        emit({ type: EVENT.ERROR, error: run.ac.signal.aborted ? 'Stopped.' : err.message });
      } finally {
        // A title still on its way gets a moment, so it lands in this stream;
        // never after a stop, which should end at once. Later, the sidebar's poll picks it up.
        if (titling && !run.ac.signal.aborted) {
          let wait: NodeJS.Timeout | undefined;
          await Promise.race([titling, new Promise<void>((r) => { wait = setTimeout(r, TITLE_WAIT_MS); })]);
          clearTimeout(wait);
        }
        store.chats.touch(chat.id);
        run.done = true;
        app.retrieval.ingest(CORPUS.CHATS, chat.id).catch((err) => log.error(`embedding chat ${chat.id} failed: ${err.message}`));
        // The run would go idle here, so the oldest queued item starts the
        // next one -- in this same synchronous block, so nothing queued before
        // `done` flipped can be missed. A stop or failure delivers nothing:
        // the queue stays put and the client hands it back to the composer.
        const ok = !run.events.some((event) => event.type === EVENT.ERROR) && !run.ac.signal.aborted;
        const next = ok && !unattended ? store.chats.takeQueued(chat.id, { first: true })[0] : null;
        if (next) {
          emit({ type: EVENT.NEXT_RUN });
          start({ chat, tools, model, lead: next.content, instructions, thinking, role });
        }
        try { onFinish?.({
          ok,
          error: (run.events.find((event) => event.type === EVENT.ERROR)?.error as string | undefined) || (run.ac.signal.aborted ? 'Stopped.' : null),
          result: store.messages.list(chat.id).slice(run.baseCount).filter((m) => m.role === 'assistant').at(-1)?.content || ''
        }); } catch { /* a run observer cannot disrupt chat teardown */ }
        for (const sub of run.subs) { try { sub.end(); } catch { /* already gone */ } }
        run.subs.clear();
        // Held briefly so a client reconnecting a second later still gets the
        // tail of the turn rather than a 404.
        setTimeout(() => { if (runs.get(chat.id) === run) runs.delete(chat.id); }, RETAIN_MS).unref();
        queueMicrotask(() => app.onRunIdle(chat.id));
      }
    })();

    return run;
  }

  /** Points one response at a run: the backlog from `from`, then the live rest. */
  function attach(run: Run, res: ServerResponse, from: number) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    for (const ev of run.events.slice(from)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (run.done) return res.end();
    run.subs.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closing */ } }, PING_MS);
    ping.unref();
    // A viewer leaving is just a viewer leaving. The run keeps going.
    res.on('close', () => { clearInterval(ping); run.subs.delete(res); });
    return undefined;
  }

  return { get, isRunning, start, attach, announceQueue };
}
