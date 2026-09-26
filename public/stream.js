/**
 * Turns a server event stream into transcript DOM. Used both by the tab that
 * sent the message and by a tab that rejoined a turn already in flight -- the
 * events are the same either way, which is what lets a reload pick a run back
 * up instead of starting over.
 */
import { state } from './state.js';
import { addTurn, addUser, addThinking, addSteps, addNotice, addError, statusOf } from './transcript.js';
import { renderQueue } from './queue.js';
import { loadChats } from './sidebar.js';

/** Resolves to `{ next }`: true when a queued follow-up started a new run. */
export async function consume(res) {
  let answer = null;
  let think = null;
  let steps = null;
  let next = false;
  // ask_user question id -> the tool call row it is drawn in.
  const asks = new Map();
  let turn = addTurn();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (!line.startsWith('data:')) continue;
        const ev = JSON.parse(line.slice(5));

        if (ev.type === 'reasoning') {
          // A fresh thought starts the next round, so close the open tool group:
          // otherwise later calls keep landing in a box further up the page while
          // each new thought appends at the bottom, and the order comes apart.
          if (!think) { steps = null; answer = null; turn.interrupt(); }
          think ||= addThinking(turn.work());
          think.push(ev.delta);
          turn.status('thinking');
        } else if (ev.type === 'text') {
          if (think) { think.done(); think = null; }
          // Prose is written at full width as the answer-so-far. If more work
          // follows, the turn demotes it into the work and this repeats.
          steps = null;
          if (!answer) { answer = turn.prose(); turn.status('writing'); }
          answer.push(ev.delta);
        } else if (ev.type === 'tool_call') {
          if (think) { think.done(); think = null; }
          answer = null;
          turn.interrupt();
          steps ||= addSteps(turn.work());
          steps.add(ev.id, ev.name, ev.args);
          turn.step();
          turn.status(statusOf(ev.name, ev.args));
        } else if (ev.type === 'approval') {
          const chatId = state.chat.id;
          steps?.ask(ev.id, async (decision) => {
            const r = await fetch(`/api/chats/${chatId}/approve`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: ev.id, decision })
            });
            // 409: already answered, e.g. from another tab -- its
            // approval_done event will settle this row too.
            if (!r.ok && r.status !== 409) throw new Error(`${r.status}`);
          });
          turn.status('waiting for approval');
        } else if (ev.type === 'approval_done') {
          steps?.settle(ev.id, ev.decision);
          turn.status(statusOf(ev.name || '', {}));
        } else if (ev.type === 'question') {
          const chatId = state.chat.id;
          // The step row is keyed by tool call id, which the question event
          // does not carry: it belongs to the ask_user row still running.
          const callId = steps?.pendingAsk?.();
          steps?.question(callId, ev, async (body) => {
            const r = await fetch(`/api/chats/${chatId}/answer`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: ev.id, ...body })
            });
            // 409: already settled -- answered in another tab, timed out or
            // stopped. Its question_done event settles this card too.
            if (!r.ok && r.status !== 409) throw new Error(`${r.status}`);
          });
          asks.set(ev.id, callId);
          turn.status('waiting for your answer');
        } else if (ev.type === 'question_done') {
          steps?.settleQuestion(asks.get(ev.id), ev.status);
          turn.status('working');
        } else if (ev.type === 'tool_result') {
          steps?.finish(ev.id, ev.result);
        } else if (ev.type === 'chat') {
          // The server owns chat ids now; a new conversation gets one here.
          const fresh = !state.chat.id;
          state.chat.id = ev.id;
          state.chat.title = ev.title;
          if (fresh) loadChats();
        } else if (ev.type === 'usage') {
          // One line per round, matching what a reopened transcript will show.
          // The turn banks it too, and sums the rounds under the answer.
          turn.usage(ev.usage);
        } else if (ev.type === 'user') {
          // Queued input delivered into this run (steering) or starting the
          // next one (a follow-up): the turn so far closes above it.
          if (think) think.done();
          think = null; steps = null; answer = null;
          turn.finish();
          addUser(ev.content);
          turn = addTurn();
        } else if (ev.type === 'queue') {
          renderQueue(ev.items);
        } else if (ev.type === 'next_run') {
          next = true;
        } else if (ev.type === 'compacted') {
          // Handled by the accompanying notice; nothing extra to draw.
        } else if (ev.type === 'done') {
          /* the server already has them */
        } else if (ev.type === 'notice') {
          think = null;
          steps = null;
          answer = null;
          turn.interrupt();
          addNotice(ev.text, turn.meta());
        } else if (ev.type === 'error') {
          addError(ev.error, turn.el);
        }
      }
    }
    if (think) think.done();
  } catch (err) {
    // Aborted on purpose by a navigation away from this chat -- the run is
    // still going server-side, and reopening the chat picks it back up.
    if (err.name !== 'AbortError') addError(err.message, turn.el);
  } finally {
    // Whatever prose is still standing was the answer; the work collapses
    // behind its recap. A turn that failed mid-flight gets the same treatment,
    // so the page is never left with the work stuck open.
    turn.finish();
  }
  return { next };
}
