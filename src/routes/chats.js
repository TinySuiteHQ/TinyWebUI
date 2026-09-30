import { json, readJson, TURN_LIMIT, IMPORT_LIMIT } from '../http.js';
import { LockedError } from '../config/config.js';
import { toView } from '../store/index.js';
import { setOverride } from '../config/approval.js';
import { actor } from '../access/auth_gate.js';
import { attachmentNote, normalizeUpload } from './documents.js';
import { FEATURE } from '../../public/shared/features.js';

const MAX_IMAGES = 8;
const F = FEATURE.CHAT;

/** Images and documents on a turn need their own features, whatever the route. */
function refusedFeature(auth, { images, documentIds }) {
  if (Array.isArray(images) && images.length && !auth.features.has(FEATURE.IMAGES)) return FEATURE.IMAGES;
  if (Array.isArray(documentIds) && documentIds.length && !auth.features.has(FEATURE.ATTACHMENTS)) return FEATURE.ATTACHMENTS;
  return null;
}

export function chatRoutes({ config, modelFor, runs, saveConfig, store, toolsFor }) {
  const noChat = (res) => json(res, 404, { error: 'no such chat' });

  return [
    // `running` is what puts the dot in the sidebar: a turn belongs to the
    // server, so a chat can be working while nothing is watching it.
    { method: 'GET', path: /^\/api\/chats$/, feature: F, handle: ({ res, auth }) => json(res, 200, {
      chats: store.chats.list(200, auth.userId).map((c) => ({ ...c, running: runs.isRunning(c.id) }))
    }) },

    // One-shot migration for transcripts still sitting in localStorage.
    // Imported tool results become artifacts like any other, so an old chat
    // is compactable the moment it is carried over.
    { method: 'POST', path: /^\/api\/chats\/import$/, feature: F, handle: async ({ req, res, auth }) => {
      const { chats = [] } = await readJson(req, IMPORT_LIMIT);
      let imported = 0;
      for (const c of chats) {
        if (!c?.id || store.chats.byId(c.id)) continue;
        store.chats.create({ id: c.id, title: c.title || 'Imported chat', createdAt: c.updated || Date.now() }, auth.userId);
        for (const m of c.messages || []) {
          const msg = { ...m };
          if (m.role === 'tool' && typeof m.content === 'string') {
            msg.artifact_id = store.messages.addArtifact(c.id, { toolName: 'imported', args: {}, content: m.content });
          }
          store.messages.add(c.id, msg);
        }
        imported++;
      }
      return json(res, 200, { imported, chats: store.chats.list(200, auth.userId) });
    } },

    { method: 'GET', path: /^\/api\/chats\/([\w.-]+)$/, feature: F, handle: ({ res, auth, params: [id] }) => {
      const found = store.chats.get(id, auth.userId);
      if (!found) return noChat(res);
      const run = runs.get(found.id);
      const live = run && !run.done;
      const messages = store.messages.list(found.id).map(toView);
      return json(res, 200, {
        id: found.id,
        title: found.title,
        folder: found.folder || null,
        epoch: found.epoch,
        // A turn in flight has already written some of itself to the store.
        // Cutting the transcript back to where the turn began lets the client
        // replay the settled part and then play the run's events over the top,
        // instead of rendering the same rounds twice.
        messages: live ? messages.slice(0, run.baseCount) : messages,
        running: Boolean(live),
        queued: store.chats.listQueued(found.id),
        tasks: store.chats.visibleTasks(found.id),
        documents: store.documents.list(found.id)
      });
    } },

    { method: 'DELETE', path: /^\/api\/chats\/([\w.-]+)$/, feature: F, handle: ({ res, auth, params: [id] }) => {
      if (!store.chats.get(id, auth.userId)) return noChat(res);
      store.chats.delete(id, auth.userId);
      return json(res, 200, { ok: true });
    } },

    { method: 'GET', path: /^\/api\/chats\/([\w.-]+)\/stream$/, feature: F, handle: ({ res, auth, url, params: [id] }) => {
      if (!store.chats.get(id, auth.userId)) return noChat(res);
      const run = runs.get(id);
      if (!run) return json(res, 404, { error: 'nothing running' });
      return runs.attach(run, res, Number(url.searchParams.get('from')) || 0);
    } },

    // Rewriting a question and answering it again. Asking the same question
    // again is the same operation with the same text, so there is one route.
    { method: 'POST', path: /^\/api\/chats\/([\w.-]+)\/edit$/, feature: F, handle: async ({ req, res, auth, params: [id] }) => {
      const found = store.chats.get(id, auth.userId);
      if (!found) return noChat(res);
      // Rewriting history under a turn that is still reading it would leave
      // the run answering a question that no longer exists.
      if (runs.isRunning(id)) return json(res, 409, { error: 'that chat is still working; stop it first' });

      const body = await readJson(req, TURN_LIMIT);
      const { seq, message, documentIds, removeDocumentIds, images } = body;
      const refused = refusedFeature(auth, body);
      if (refused) return json(res, 403, { error: 'feature_disabled', feature: refused });
      const text = String(message ?? '').trim();
      if (!text) return json(res, 400, { error: 'message is required' });
      const target = store.messages.list(id).find((m) => m.seq === Number(seq));
      if (!target || target.role !== 'user') {
        return json(res, 400, { error: 'seq must name a question of your own' });
      }

      store.chats.truncateFrom(id, Number(seq));
      // A document is chat-scoped, not part of the message row that just got
      // truncated, so dropping one during edit takes an explicit delete --
      // this is the only place that happens. Nothing survives that would
      // still reference it: truncateFrom already took every later message
      // (the only other place a reference could live) with it.
      for (const docId of Array.isArray(removeDocumentIds) ? removeDocumentIds : []) {
        const doc = store.documents.get(docId, auth.userId);
        if (doc?.chat_id === id) store.documents.delete(docId, auth.userId);
      }
      let content = text;
      for (const docId of Array.isArray(documentIds) ? documentIds : []) {
        const doc = store.documents.get(docId, auth.userId);
        if (doc?.chat_id === id) content += attachmentNote(doc);
      }
      const kept = Array.isArray(images) ? images.filter((img) => img?.mime && img?.data) : [];
      store.messages.add(id, { role: 'user', content, ...(kept.length ? { images: kept } : {}) });

      // The run is started but not streamed back here. The client reloads the
      // rewound transcript and then attaches, the same path a reload takes,
      // rather than reading a stream through a response it also has to
      // redraw behind.
      runs.start({ chat: found, tools: toolsFor(auth.features), model: modelFor(auth.user?.id, auth.role) });
      return json(res, 200, { ok: true, running: true });
    } },

    // The user's answer to an approval prompt in the transcript.
    { method: 'POST', path: /^\/api\/chats\/([\w.-]+)\/approve$/, feature: F, handle: async ({ req, res, auth, params: [chatId] }) => {
      if (!store.chats.get(chatId, auth.userId)) return noChat(res);
      const { id, decision } = await readJson(req);
      if (!['allow', 'always', 'deny'].includes(decision)) {
        return json(res, 400, { error: 'decision must be allow, always or deny' });
      }
      const run = runs.get(chatId);
      const pending = run?.approvals.get(id);
      if (!pending) return json(res, 409, { error: 'that call is no longer waiting' });
      run.approvals.delete(id);
      // "Always" rewrites tool policy, which is the tools feature's to do;
      // without it, the answer counts as allowing this one call.
      if (decision === 'always' && auth.features.has(FEATURE.TOOLS)) {
        // Approval lists set in code cannot be saved to; allow this call only.
        try { saveConfig(setOverride(config(), pending.name, 'auto'), actor(auth)); }
        catch (err) { if (!(err instanceof LockedError)) throw err; }
      }
      pending.resolve(decision);
      return json(res, 200, { ok: true });
    } },

    // The user's answer to an ask_user question, or `skip` to let the run
    // continue without one. Only the run's own open question can be
    // answered; anything else (answered, timed out, stopped) is a 409.
    { method: 'POST', path: /^\/api\/chats\/([\w.-]+)\/answer$/, feature: F, handle: async ({ req, res, auth, params: [chatId] }) => {
      if (!store.chats.get(chatId, auth.userId)) return noChat(res);
      const { id, answer, skip } = await readJson(req, TURN_LIMIT);
      const gone = () => json(res, 409, { error: 'that question is no longer waiting' });
      const pending = runs.get(chatId)?.question;
      if (!pending || pending.id !== id) return gone();
      if (skip === true) return pending.settle('skipped') ? json(res, 200, { ok: true }) : gone();
      const text = String(answer ?? '').trim();
      if (!text) return json(res, 400, { error: 'answer is required' });
      if (!pending.allowFreeText && !pending.choices.includes(text)) {
        return json(res, 400, { error: 'answer must be one of the offered choices' });
      }
      return pending.settle('answered', text) ? json(res, 200, { ok: true }) : gone();
    } },

    // Input sent while a turn is running. Refused when nothing interactive
    // is running (send it normally) and while an automation holds the chat.
    { method: 'POST', path: /^\/api\/chats\/([\w.-]+)\/queue$/, feature: F, handle: async ({ req, res, auth, params: [chatId] }) => {
      if (!store.chats.get(chatId, auth.userId)) return noChat(res);
      const { id, kind, message } = await readJson(req, TURN_LIMIT);
      const text = String(message ?? '').trim();
      if (!text) return json(res, 400, { error: 'message is required' });
      if (!['steer', 'followup'].includes(kind)) return json(res, 400, { error: 'kind must be steer or followup' });
      if (typeof id !== 'string' || !/^[\w.-]{1,64}$/.test(id)) return json(res, 400, { error: 'id is required' });
      const run = runs.get(chatId);
      if (!run || run.done) return json(res, 409, { error: 'nothing is running; send it as a message' });
      if (run.unattended) return json(res, 409, { error: 'an automation is running in this chat; wait for it to finish' });
      store.chats.addQueued(chatId, { id, kind, content: text });
      runs.announceQueue(chatId);
      return json(res, 200, { ok: true, items: store.chats.listQueued(chatId) });
    } },

    { method: 'DELETE', path: /^\/api\/chats\/([\w.-]+)\/queue\/([\w.-]+)$/, feature: F, handle: ({ res, auth, params: [chatId, itemId] }) => {
      if (!store.chats.get(chatId, auth.userId)) return noChat(res);
      const removed = store.chats.deleteQueued(chatId, itemId);
      runs.announceQueue(chatId);
      return json(res, removed ? 200 : 409, removed ? { ok: true } : { error: 'already delivered' });
    } },

    { method: 'POST', path: /^\/api\/chats\/([\w.-]+)\/stop$/, feature: F, handle: ({ res, auth, params: [chatId] }) => {
      if (!store.chats.get(chatId, auth.userId)) return noChat(res);
      runs.get(chatId)?.ac.abort();
      return json(res, 200, { ok: true });
    } },

    { method: 'POST', path: /^\/api\/chat$/, feature: F, handle: async ({ req, res, auth }) => {
      const body = await readJson(req, TURN_LIMIT);
      const { chatId, message, documentIds, images } = body;
      const refused = refusedFeature(auth, body);
      if (refused) return json(res, 403, { error: 'feature_disabled', feature: refused });
      if (!config().apiKey) return json(res, 400, { error: 'No API key. Set TINYWEBUI_API_KEY or apiKey in the config file.' });
      if (!message) return json(res, 400, { error: 'message is required' });

      // The client no longer ships the transcript: it sends the new turn and
      // the server replays what it already holds. That is what stops a
      // page-sized tool result from crossing the wire on every message.
      const owned = chatId && store.chats.get(chatId, auth.userId);
      // Someone else's id is "no such chat", never a primary-key clash.
      if (chatId && !owned && store.chats.byId(chatId)) return noChat(res);
      const chat = owned || store.chats.create({ id: chatId, title: String(message).slice(0, 60) }, auth.userId);

      // Attachments are surfaced as plain text inline notes rather than a
      // system-prompt change, the same idiom compact.js uses for a compacted
      // artifact -- the model sees "[Attached document: ...]" in the message
      // it's already reading and knows to call read_document on the id.
      let content = String(message);
      for (const id of Array.isArray(documentIds) ? documentIds : []) {
        const doc = store.documents.get(id, auth.userId);
        if (!doc || doc.chat_id !== chat.id) continue;
        content += attachmentNote(doc);
      }

      // Images ride directly on the message as OpenAI multimodal content
      // parts -- unlike a document there is no text to extract, so the bytes
      // have to go up with the turn that attached them. Usually already
      // normalized client-side (/api/images/normalize); normalizing again is a
      // cheap passthrough then, and a safety net for callers that skipped it.
      const imgs = [];
      for (const img of Array.isArray(images) ? images.slice(0, MAX_IMAGES) : []) {
        const normalized = await normalizeUpload(img?.mime, img?.dataBase64);
        if (normalized) imgs.push(normalized);
      }

      store.messages.add(chat.id, { role: 'user', content, ...(imgs.length ? { images: imgs } : {}) });

      // The turn is started, not awaited. Closing the tab detaches a
      // listener; it no longer kills the work, and the answer is in the store
      // whether or not anyone was watching when it landed.
      const existing = runs.get(chat.id);
      const run = existing && !existing.done
        ? existing
        : runs.start({ chat, tools: toolsFor(auth.features), model: modelFor(auth.user?.id, auth.role) });
      return runs.attach(run, res, 0);
    } }
  ];
}
