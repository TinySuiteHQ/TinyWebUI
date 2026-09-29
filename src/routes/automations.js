import { json, readJson } from '../http.js';
import { validateSchedule } from '../automations/automation.js';

/** `newChatTitle` on an automation request: undefined when absent, false when
 * present but unusable, otherwise the trimmed title. */
function newChatTitleOf(body) {
  if (body.newChatTitle === undefined || body.newChatTitle === null) return undefined;
  const title = String(body.newChatTitle).trim();
  return title && title.length <= 120 ? title : false;
}

const BAD_TITLE = { error: 'the new chat needs a name (at most 120 characters)' };

export function automationRoutes(app) {
  const { store, scheduler } = app;
  const F = 'automations';
  return [
    { method: 'GET', path: /^\/api\/automations$/, feature: F, handle: ({ res, auth }) =>
      json(res, 200, { automations: store.listAutomations(auth.userId), chats: store.listChats(200, auth.userId) }) },

    { method: 'POST', path: /^\/api\/automations$/, feature: F, handle: async ({ req, res, auth }) => {
      const body = await readJson(req);
      const newChatTitle = newChatTitleOf(body);
      if (newChatTitle === false) return json(res, 400, BAD_TITLE);
      let chat = newChatTitle ? null : store.getChat(String(body.chatId || ''), auth.userId);
      if (!newChatTitle && !chat) return json(res, 400, { error: 'a chat you own is required' });
      const name = String(body.name || '').trim();
      const prompt = String(body.prompt || '').trim();
      if (!name || !prompt) return json(res, 400, { error: 'name and prompt are required' });
      if (name.length > 120 || prompt.length > 12000) return json(res, 400, { error: 'name or prompt is too long' });
      let schedule;
      try { schedule = validateSchedule(body.cron, body.timezone); }
      catch (err) { return json(res, 400, { error: err.message }); }
      if (newChatTitle) chat = store.createChat({ title: newChatTitle }, auth.userId);
      const automation = store.createAutomation({ ...schedule, chatId: chat.id, name, prompt, enabled: body.enabled !== false, source: 'user' }, auth.userId);
      scheduler.arm();
      return json(res, 201, { automation });
    } },

    { method: 'GET', path: /^\/api\/automations\/([\w.-]+)\/runs$/, feature: F, handle: ({ res, auth, params: [id] }) => {
      const runs = store.listAutomationRuns(id, auth.userId);
      return runs ? json(res, 200, { runs }) : json(res, 404, { error: 'no such automation' });
    } },

    { method: 'POST', path: /^\/api\/automations\/([\w.-]+)\/trigger$/, feature: F, handle: async ({ res, auth, params: [id] }) => {
      const automation = store.getAutomation(id, auth.userId);
      if (!automation) return json(res, 404, { error: 'no such automation' });
      const run = await scheduler.trigger(automation, auth.userId);
      return json(res, 202, { run });
    } },

    { method: 'PATCH', path: /^\/api\/automations\/([\w.-]+)$/, feature: F, handle: async ({ req, res, auth, params: [id] }) => {
      const existing = store.getAutomation(id, auth.userId);
      if (!existing) return json(res, 404, { error: 'no such automation' });
      const body = await readJson(req);
      const patch = {};
      for (const key of ['name', 'prompt', 'cron', 'timezone', 'enabled', 'chatId']) if (body[key] !== undefined) patch[key] = body[key];
      const newChatTitle = newChatTitleOf(body);
      if (newChatTitle === false) return json(res, 400, BAD_TITLE);
      if (newChatTitle) delete patch.chatId;
      if (patch.chatId !== undefined) {
        const chat = store.getChat(String(patch.chatId), auth.userId);
        if (!chat) return json(res, 400, { error: 'a chat you own is required' });
        patch.chatId = chat.id;
      }
      if (patch.name !== undefined) {
        patch.name = String(patch.name).trim();
        if (!patch.name || patch.name.length > 120) return json(res, 400, { error: 'name is required and must be at most 120 characters' });
      }
      if (patch.prompt !== undefined) {
        patch.prompt = String(patch.prompt).trim();
        if (!patch.prompt || patch.prompt.length > 12000) return json(res, 400, { error: 'prompt is required and must be at most 12000 characters' });
      }
      if (patch.cron !== undefined || patch.timezone !== undefined) {
        let schedule;
        try { schedule = validateSchedule(patch.cron ?? existing.cron, patch.timezone ?? existing.timezone); }
        catch (err) { return json(res, 400, { error: err.message }); }
        Object.assign(patch, schedule);
      }
      if (newChatTitle) patch.chatId = store.createChat({ title: newChatTitle }, auth.userId).id;
      const automation = store.updateAutomation(id, patch, auth.userId);
      scheduler.arm();
      return json(res, 200, { automation });
    } },

    { method: 'DELETE', path: /^\/api\/automations\/([\w.-]+)$/, feature: F, handle: ({ res, auth, params: [id] }) => {
      if (!store.deleteAutomation(id, auth.userId)) return json(res, 404, { error: 'no such automation' });
      scheduler.arm();
      return json(res, 200, { ok: true });
    } }
  ];
}
