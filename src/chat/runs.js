import { randomUUID } from 'node:crypto';
import { runChat } from './llm.js';
import { effectiveConfig } from '../config/models.js';
import { logger } from '../log.js';
import { EVENT } from '../../public/shared/events.js';
import { CORPUS } from '../store/index.js';

const log = logger('retrieval');

const RETAIN_MS = 5 * 60 * 1000;

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
export function createRuns(app) {
  const { store } = app;
  const runs = new Map();

  const get = (chatId) => runs.get(chatId);
  const isRunning = (chatId) => {
    const run = runs.get(chatId);
    return Boolean(run && !run.done);
  };

  /** Tells everyone watching a chat's run what is queued now. */
  const announceQueue = (chatId) => runs.get(chatId)?.emit({ type: EVENT.QUEUE, items: store.chats.listQueued(chatId) });

  /**
   * `lead` is a queued follow-up that starts this run: stored after baseCount
   * and sent as an event, so a live view and a reload each show it once.
   */
  function start({ chat, tools, onFinish, historyFromSeq = null, unattended = false, model = null, lead = null }) {
    const run = {
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
      unattended
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
    const approve = unattended ? null : ({ id, name }) =>
      new Promise((resolve) => run.approvals.set(id, { name, resolve }));

    /**
     * Puts one ask_user question to the user and waits: for an answer, a
     * skip, the timeout, or a stop. Persisted first, so the row decides who
     * settled it; the timer is read from the live config at ask time.
     */
    const askUser = unattended ? null : ({ question, choices, allowFreeText }) => {
      if (run.ac.signal.aborted) return Promise.resolve({ answered: false, reason: 'cancelled' });
      // Calls are sequential, so a second one can only arrive after the first
      // settled; this is the guard should that ever change.
      if (run.question) return Promise.resolve({ answered: false, reason: 'busy' });
      const id = randomUUID();
      const seconds = Math.max(0, Number(app.cfg.askUserTimeoutSeconds) || 0);
      const deadline = seconds ? Date.now() + seconds * 1000 : null;
      store.chats.addQuestion(chat.id, { id, question, choices, allowFreeText, deadline });
      return new Promise((resolve) => {
        let timer = null;
        const settle = (status, answer = null) => {
          if (!store.chats.settleQuestion(id, status, answer)) return false;
          clearTimeout(timer);
          if (run.question?.id === id) run.question = null;
          emit({ type: EVENT.QUESTION_DONE, id, status, answer });
          resolve(status === 'answered' ? { answered: true, answer } : { answered: false, reason: status });
          return true;
        };
        run.question = { id, choices, allowFreeText, settle };
        if (deadline) timer = setTimeout(() => settle('timeout'), seconds * 1000);
        emit({ type: EVENT.QUESTION, id, question, choices, allowFreeText, deadline, timeoutSeconds: seconds });
      });
    };

    const emit = (event) => {
      run.events.push(event);
      for (const sub of run.subs) {
        try { sub.write(`data: ${JSON.stringify(event)}\n\n`); } catch { run.subs.delete(sub); }
      }
    };

    run.emit = emit;
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

    run.promise = (async () => {
      try {
        await runChat({ cfg: effectiveConfig(app.cfg, model), chatId: chat.id, store, tools, hub: app.hub, emit, signal: run.ac.signal, historyFromSeq, unattended, approve, takeInput, askUser });
      } catch (err) {
        emit({ type: EVENT.ERROR, error: run.ac.signal.aborted ? 'Stopped.' : err.message });
      } finally {
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
          start({ chat, tools, model, lead: next.content });
        }
        try { onFinish?.({
          ok,
          error: run.events.find((event) => event.type === EVENT.ERROR)?.error || (run.ac.signal.aborted ? 'Stopped.' : null),
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
  function attach(run, res, from) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    for (const ev of run.events.slice(from)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (run.done) return res.end();
    run.subs.add(res);
    // A viewer leaving is just a viewer leaving. The run keeps going.
    res.on('close', () => run.subs.delete(res));
    return undefined;
  }

  return { get, isRunning, start, attach, announceQueue };
}
