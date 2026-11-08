/**
 * The chat on screen: its transcript model, the run streaming into it, and
 * what is typed, queued or held for it. A run is the server's -- it outlives
 * this tab -- so the page only ever follows one: by sending, or by rejoining
 * a run already in flight from the top of its event buffer.
 */
import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import { api, type ApiError } from '../core/api.ts';
import { events } from '../core/sse.ts';
import { newId } from '../core/id.ts';
import {
  createModel, applyEvent, replay, finishTurn, beginTurn, addUser, addError as modelError,
  type Model, type StreamEvent, type StoredMessage, type Img, type QueueItem
} from '../model/turn-model.ts';
import { EVENT } from '../../../shared/events.ts';
import { useSession } from './session.ts';
import { useChats } from './chats.ts';
import { useAttachments, stagedName } from './attachments.ts';
import { useUi } from './ui.ts';

// 409 on a reply means another tab settled it first; its done event updates this one.
const unless409 = (err: ApiError) => { if (err.status !== 409) throw err; };

type Held = { id: string, content: string };

export const useChat = defineStore('chat', () => {
  const model = ref<Model>(createModel());
  /** A turn is streaming into this view right now. */
  const busy = ref(false);
  /** The id of a chat being opened, while its history loads. */
  const loading = ref<string | null>(null);
  const draft = ref('');
  /** Bumped to ask the composer for focus (after a turn, after New). */
  const focusTick = ref(0);
  // Follow-ups held in the browser per chat until their send is clicked. They
  // survive switching chats, not a reload.
  const held = reactive(new Map<string, Held[]>());

  // The fetch reading a run's stream belongs to whichever view started it;
  // switching chats aborts it (the run goes on server-side).
  let viewCtrl: AbortController | null = null;
  // A slower earlier click must never replace the chat selected most recently.
  let loadCtrl: AbortController | null = null;

  const chatId = computed(() => model.value.chat.id);
  const empty = computed(() => model.value.items.length === 0 && !loading.value);
  const heldHere = computed(() => (chatId.value && held.get(chatId.value)) || []);

  const addError = (text: string) => modelError(model.value, text);

  /* ---------- the address bar ---------- */

  // ?chat=<id> names the chat on screen, so a reload lands back in it -- and,
  // mid-turn, back in the run through the same rejoin a chat switch uses.
  function setUrl(id: string | null, mode: 'push' | 'replace') {
    const url = id ? `${location.pathname}?chat=${encodeURIComponent(id)}` : location.pathname;
    if (url === location.pathname + location.search) return;
    history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url);
  }

  /* ---------- following a run ---------- */

  /**
   * Folds a server event stream into `m`. Events are applied once per frame,
   * not per token: a fast stream would otherwise re-render the answer (and
   * re-parse its markdown) hundreds of times a second.
   * Resolves to `{ next }`: true when a queued follow-up started a new run.
   */
  async function consume(res: Response, m: Model): Promise<{ next: boolean }> {
    m.nextRun = false;
    beginTurn(m);
    const queue: StreamEvent[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      for (const ev of queue.splice(0)) {
        applyEvent(m, ev);
        // Every stream opens with the chat's id, which the server owns: the
        // address takes it, and a chat new to the sidebar shows up there.
        if (ev.type === EVENT.CHAT && model.value === m) {
          setUrl(ev.id, 'replace');
          if (!useChats().chats.some((c) => c.id === ev.id)) useChats().load();
        }
      }
    };
    try {
      for await (const ev of events(res)) {
        queue.push(ev);
        if (!frame) frame = requestAnimationFrame(flush);
      }
    } catch (err) {
      // Aborted on purpose by a navigation away: the run goes on server-side,
      // and reopening the chat picks it back up.
      if (err.name !== 'AbortError') queue.push({ type: EVENT.ERROR, error: err.message });
    } finally {
      cancelAnimationFrame(frame);
      flush();
      // Whatever prose is still standing was the answer; the work folds behind it.
      finishTurn(m);
    }
    return { next: m.nextRun };
  }

  /** Cancels whatever stream read the view on screen owns. */
  function leaveView() {
    viewCtrl?.abort();
    viewCtrl = null;
    busy.value = false;
  }

  function cancelLoad() {
    loadCtrl?.abort();
    loadCtrl = null;
    loading.value = null;
  }

  /** After a stream ends: follow the run a follow-up started, or take back what never went. */
  async function afterRun(outcome: { next: boolean } | undefined, id: string | null) {
    if (!id || chatId.value !== id) return;
    if (outcome?.next) return rejoin(id);
    await reclaimQueue();
    return undefined;
  }

  /** Follows a turn already in flight, from the top of its event buffer. */
  async function rejoin(id: string) {
    const ctrl = new AbortController();
    viewCtrl = ctrl;
    busy.value = true;
    const m = model.value;
    let outcome;
    try {
      const res = await fetch(`/api/chats/${encodeURIComponent(id)}/stream?from=0`, { signal: ctrl.signal });
      if (res.ok) outcome = await consume(res, m);
    } catch {
      // Navigating away aborts this on purpose; anything else means the
      // transcript is in the store and reopening picks it up.
    }
    // A later navigation already swapped in its own controller and reset
    // `busy` for its own view; stepping on either here would be wrong.
    if (viewCtrl === ctrl) {
      viewCtrl = null;
      busy.value = false;
      focusTick.value++;
      useChats().load();
      await afterRun(outcome, id);
    }
  }

  /* ---------- switching chats ---------- */

  function newChat({ url = true } = {}) {
    cancelLoad();
    leaveView();
    model.value = createModel();
    useAttachments().reset();
    // Starting fresh is a clear signal that browsing is done; a lingering
    // search would still sit over the sidebar, and on a phone the drawer over
    // the composer.
    useChats().clearSearch();
    useUi().closeDrawer();
    if (url) setUrl(null, 'push');
    focusTick.value++;
  }

  async function openChat(id: string, { url = 'push' as 'push' | 'replace' | false } = {}) {
    cancelLoad();
    const ctrl = new AbortController();
    loadCtrl = ctrl;
    loading.value = id;
    let found;
    try {
      found = await api.get(`/api/chats/${encodeURIComponent(id)}`, { signal: ctrl.signal });
    } catch (err) {
      if (loadCtrl === ctrl) {
        loadCtrl = null;
        loading.value = null;
        if (err.name !== 'AbortError') {
          addError(`Could not open chat (${err.message})`);
          // A chat named in the address that no longer exists (or is not
          // yours) should not stay named there.
          if ((err as ApiError).status === 404) setUrl(chatId.value, 'replace');
        }
      }
      return;
    }
    if (loadCtrl !== ctrl) return;
    loadCtrl = null;
    loading.value = null;
    leaveView();
    // Built outside reactivity, then swapped in whole: replaying a long chat
    // through a proxy would cost far more than the swap.
    const m = createModel({ id: found.id, title: found.title });
    // Mid-turn, the server hands back only the settled part of the transcript;
    // the rest arrives as events, exactly as it did for the tab that started it.
    replay(m, (found.messages || []) as StoredMessage[], found.documents || []);
    m.queue = found.queued || [];
    m.tasks = found.tasks || [];
    model.value = m;
    // No images endpoint: every image rides on the user message that attached it.
    const images = (found.messages || [])
      .filter((msg: StoredMessage) => msg.role === 'user' && msg.images?.length)
      .flatMap((msg: StoredMessage) => msg.images as Img[]);
    useAttachments().reset(found.documents || [], images);
    useChats().clearSearch();
    useUi().closeDrawer();
    if (url) setUrl(found.id, url);
    if (found.running) rejoin(found.id);
    else reclaimQueue();
  }

  /* ---------- sending ---------- */

  async function send() {
    if (busy.value) {
      if (draft.value.trim()) return queueInput('steer');
      return stop();
    }
    const attachments = useAttachments();
    const text = draft.value.trim();
    const hasAttachments = attachments.pending.length > 0;
    if (!text && !hasAttachments) return undefined;
    // A message must never go out without an attachment the person thinks is
    // on it: the model would act on the text alone.
    const invalid = hasAttachments ? await attachments.invalid() : [];
    if (invalid.length) {
      addError(`remove ${invalid.map((a) => `"${stagedName(a)}"`).join(', ')} before sending`);
      return undefined;
    }
    draft.value = '';
    const m = model.value;
    // A question is going out: finished tasks are done with, as the server will agree.
    if (m.tasks) m.tasks = m.tasks.filter((t) => t.status !== 'completed');
    busy.value = true;
    const ctrl = new AbortController();
    viewCtrl = ctrl;
    // Assigned before any await, so the uploads and the /api/chat call that
    // follows land on the same not-yet-created chat.
    if (!m.chat.id) m.chat.id = newId();
    const id = m.chat.id;
    const { docs, images, failed } = await attachments.commit(id, addError);
    if (failed.length) {
      draft.value = text;
      if (viewCtrl === ctrl) { viewCtrl = null; busy.value = false; }
      return undefined;
    }
    if (!text && !docs.length && !images.length) { busy.value = false; return undefined; }

    const message = text || (images.length ? '(attached image)' : '(attached document)');
    addUser(m, message, null, docs, images);

    let outcome;
    try {
      // Only the new turn goes up. The server replays the rest from its own
      // copy, so a page-sized tool result crosses the wire once, not every turn.
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: id, message, documentIds: docs.map((d) => d.id), images, thinking: useSession().thinkingPick }),
        signal: ctrl.signal
      });
      if (!res.ok) {
        const out = await res.json().catch(() => ({}));
        throw new Error(out.error || `status ${res.status}`);
      }
      outcome = await consume(res, m);
      useChats().load();
    } catch (err) {
      if (err.name !== 'AbortError') modelError(m, err.message);
    } finally {
      if (viewCtrl === ctrl) {
        viewCtrl = null;
        busy.value = false;
        focusTick.value++;
        afterRun(outcome, id);
      }
    }
    return undefined;
  }

  /** Closing the tab no longer stops a turn, so there has to be a way to actually mean it. */
  async function stop() {
    if (!chatId.value) return;
    try { await api.post(`/api/chats/${chatId.value}/stop`); } catch (err) { addError(`couldn't stop: ${err.message}`); }
  }

  /* ---------- queued and held input ---------- */

  /** Sends what is typed into the running turn instead of starting a new one. */
  async function queueInput(kind: 'steer' | 'followup') {
    const text = draft.value.trim();
    if (!text || !chatId.value) return;
    draft.value = '';
    // false: the turn finished in the meantime, so this is just the next message.
    if (!(await enqueue(kind, text))) {
      draft.value = text;
      busy.value = false;
      await send();
    }
  }

  /** Queues `text` on the running turn. False when there is no run to take it. */
  async function enqueue(kind: string, text: string): Promise<boolean> {
    const m = model.value;
    try {
      const out = await api.post(`/api/chats/${m.chat.id}/queue`, { id: newId(), kind, message: text });
      m.queue = out.items;
    } catch (err) {
      if (err.status === 409) return false;
      modelError(m, err.message);
    }
    return true;
  }

  async function removeQueued(item: QueueItem) {
    // 409: already delivered; the transcript shows it, and the next queue event redraws the list.
    try { await api.del(`/api/chats/${chatId.value}/queue/${encodeURIComponent(item.id)}`); } catch (err) {
      if (err.status !== 409) addError(`couldn't remove queued message: ${err.message}`);
    }
  }

  /**
   * A run that was stopped (or failed, or a server that restarted) delivers
   * nothing it had queued. Rather than send it anyway or drop it, it goes back
   * into the composer, to be sent or edited by hand.
   */
  async function reclaimQueue() {
    const m = model.value;
    const items = m.queue;
    if (!items.length || !m.chat.id) return;
    draft.value = [...items.map((i) => i.content), draft.value].filter(Boolean).join('\n\n');
    m.queue = [];
    await Promise.all(items.map((i) => api.del(`/api/chats/${m.chat.id}/queue/${encodeURIComponent(i.id)}`).catch(() => {})));
  }

  /** Alt+Enter while a turn runs: parks what is typed until its send is clicked. */
  function holdInput() {
    const text = draft.value.trim();
    const id = chatId.value;
    if (!text || !id) return;
    draft.value = '';
    held.set(id, [...(held.get(id) || []), { id: newId(), content: text }]);
  }

  function dropHeld(item: Held) {
    const id = chatId.value;
    if (id) held.set(id, (held.get(id) || []).filter((i) => i.id !== item.id));
  }

  /** A held follow-up, confirmed: into the running turn, or as the next message. */
  function sendHeld(item: Held) {
    dropHeld(item);
    if (busy.value) { draft.value = item.content; queueInput('steer'); return; }
    draft.value = [item.content, draft.value.trim()].filter(Boolean).join('\n\n');
    send();
  }

  /* ---------- answering the run ---------- */

  async function approve(callId: string, decision: 'allow' | 'always' | 'deny') {
    await api.post(`/api/chats/${chatId.value}/approve`, { id: callId, decision }).catch(unless409);
  }

  async function answer(qid: string, body: { answer: string } | { skip: true }) {
    await api.post(`/api/chats/${chatId.value}/answer`, { id: qid, ...body }).catch(unless409);
  }

  /**
   * Rewinds the conversation to a question and runs it forward again.
   * Everything after it is gone; reopening the chat redraws what is left and
   * rejoins the run now producing the rest, as a reload mid-turn would.
   */
  async function rewind(payload: Record<string, unknown>) {
    const id = chatId.value;
    if (busy.value || !id) return;
    try { await api.post(`/api/chats/${id}/edit`, { ...payload, thinking: useSession().thinkingPick }); } catch (err) { addError(err.message); return; }
    await openChat(id, { url: false });
  }

  /* ---------- wiring ---------- */

  function init() {
    // A run is the server's, so the dot in the sidebar can change without this
    // tab doing anything. Poll only while there is something to watch.
    const chats = useChats();
    setInterval(async () => {
      if (!busy.value && !chats.chats.some((c) => c.running)) return;
      await chats.load();
      const id = chatId.value;
      if (!busy.value && id && chats.chats.some((c) => c.id === id && c.running)) rejoin(id);
    }, 4000);
    addEventListener('popstate', () => {
      const id = new URLSearchParams(location.search).get('chat');
      if (id && id !== chatId.value) openChat(id, { url: false });
      else if (!id && chatId.value) newChat({ url: false });
    });
  }

  /** The chat named in the address, else a fresh one. */
  function start() {
    const id = new URLSearchParams(location.search).get('chat');
    if (id) openChat(id, { url: false });
    else newChat({ url: false });
  }

  return {
    model, busy, loading, draft, focusTick, chatId, empty, heldHere,
    addError, newChat, openChat, send, stop, queueInput, holdInput, dropHeld, sendHeld, removeQueued,
    approve, answer, rewind, init, start
  };
});
