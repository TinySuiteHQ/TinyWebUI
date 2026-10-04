/**
 * Turns a server event stream into transcript DOM. Used both by the tab that
 * sent the message and by a tab that rejoined a turn already in flight -- the
 * events are the same either way, which is what lets a reload pick a run back
 * up instead of starting over.
 */
import { state } from '../core/state.js';
import { addTurn, addUser, addThinking, addSteps, addNotice, addError, statusOf } from './transcript.js';
import { renderQueue } from './queue.js';
import { loadChats } from './sidebar.js';
import { renderTasks } from './tasks.js';
import { EVENT } from '../shared/events.js';
import { api } from '../core/api.js';

// 409 on a reply means another tab settled it first; its done event updates this one.
const unless409 = (err) => { if (err.status !== 409) throw err; };

/** Resolves to `{ next }`: true when a queued follow-up started a new run. */
export async function consume(res) {
  const view = turnView();
  try {
    for await (const ev of events(res)) view.handle(ev);
    view.endThought();
  } catch (err) {
    // Aborted on purpose by a navigation away from this chat -- the run is
    // still going server-side, and reopening the chat picks it back up.
    if (err.name !== 'AbortError') addError(err.message, view.turn().el);
  } finally {
    // Whatever prose is still standing was the answer; the work collapses
    // behind its recap. A turn that failed mid-flight gets the same treatment,
    // so the page is never left with the work stuck open.
    view.turn().finish();
  }
  return { next: view.next() };
}

/** The `data:` frames of a server-sent event stream, parsed. */
async function* events(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 2);
      if (line.startsWith('data:')) yield JSON.parse(line.slice(5));
    }
  }
}

/**
 * What one stream is drawing: the current turn and the open thought, answer
 * and tool group inside it. Each event type has one handler below.
 */
function turnView() {
  let turn = addTurn();
  let answer = null;
  let think = null;
  let steps = null;
  let next = false;
  // ask_user question id -> the tool call row it is drawn in.
  const asks = new Map();

  const endThought = () => { if (think) { think.done(); think = null; } };

  const HANDLERS = {
    [EVENT.REASONING]: (ev) => {
      // A fresh thought starts the next round, so close the open tool group:
      // otherwise later calls keep landing in a box further up the page while
      // each new thought appends at the bottom, and the order comes apart.
      if (!think) { steps = null; answer = null; turn.interrupt(); }
      think ||= addThinking(turn.work());
      think.push(ev.delta);
      turn.status('thinking');
    },
    [EVENT.TEXT]: (ev) => {
      endThought();
      // Prose is written at full width as the answer-so-far. If more work
      // follows, the turn demotes it into the work and this repeats.
      steps = null;
      if (!answer) { answer = turn.prose(); turn.status('writing'); }
      answer.push(ev.delta);
    },
    [EVENT.TOOL_CALL]: (ev) => {
      endThought();
      answer = null;
      turn.interrupt();
      steps ||= addSteps(turn.work());
      steps.add(ev.id, ev.name, ev.args);
      turn.step();
      turn.status(statusOf(ev.name, ev.args));
    },
    [EVENT.APPROVAL]: (ev) => {
      const chatId = state.chat.id;
      steps?.ask(ev.id, async (decision) => {
        await api.post(`/api/chats/${chatId}/approve`, { id: ev.id, decision }).catch(unless409);
      });
      turn.status('waiting for approval');
    },
    [EVENT.APPROVAL_DONE]: (ev) => {
      steps?.settle(ev.id, ev.decision);
      turn.status(statusOf(ev.name || '', {}));
    },
    [EVENT.QUESTION]: (ev) => {
      const chatId = state.chat.id;
      // The step row is keyed by tool call id, which the question event
      // does not carry: it belongs to the ask_user row still running.
      const callId = steps?.pendingAsk?.();
      steps?.question(callId, ev, async (body) => {
        await api.post(`/api/chats/${chatId}/answer`, { id: ev.id, ...body }).catch(unless409);
      });
      asks.set(ev.id, callId);
      turn.status('waiting for your answer');
    },
    [EVENT.QUESTION_DONE]: (ev) => {
      steps?.settleQuestion(asks.get(ev.id), ev.status);
      turn.status('working');
    },
    [EVENT.TOOL_RESULT]: (ev) => steps?.finish(ev.id, ev.result),
    [EVENT.TASKS]: (ev) => renderTasks(ev.tasks),
    [EVENT.CHAT]: (ev) => {
      // The server owns chat ids now; a new conversation gets one here.
      const fresh = !state.chat.id;
      state.chat.id = ev.id;
      state.chat.title = ev.title;
      if (fresh) loadChats();
    },
    // One line per round, matching what a reopened transcript will show.
    // The turn banks it too, and sums the rounds under the answer.
    [EVENT.USAGE]: (ev) => turn.usage(ev.usage),
    [EVENT.USER]: (ev) => {
      // Queued input delivered into this run (steering) or starting the
      // next one (a follow-up): the turn so far closes above it.
      endThought();
      steps = null; answer = null;
      turn.finish();
      addUser(ev.content);
      turn = addTurn();
    },
    [EVENT.QUEUE]: (ev) => renderQueue(ev.items),
    [EVENT.NEXT_RUN]: () => { next = true; },
    [EVENT.COMPACTED]: () => { /* drawn by the notice that accompanies it */ },
    [EVENT.DONE]: () => { /* the server already has the messages */ },
    [EVENT.NOTICE]: (ev) => {
      think = null; steps = null; answer = null;
      turn.interrupt();
      addNotice(ev.text, turn.meta());
    },
    [EVENT.ERROR]: (ev) => addError(ev.error, turn.el)
  };

  return {
    handle: (ev) => HANDLERS[ev.type]?.(ev),
    endThought,
    turn: () => turn,
    next: () => next
  };
}
