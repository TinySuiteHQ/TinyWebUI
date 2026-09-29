import { nextSchedule, runMessage } from './automation.js';

/**
 * Runs automations: on their cron schedule, or on demand. A run needs its
 * chat idle; a manual trigger for a busy chat waits in a per-chat queue and
 * starts once the chat's current run ends (`drain`, which the run manager
 * calls). Scheduled occurrences that find the chat busy are skipped, not
 * queued, and occurrences missed while the process was down are not replayed.
 *
 * `app` supplies the store, runs, and modelFor/toolsFor/ownerFeatures.
 */
export function createScheduler(app) {
  const { store, runs } = app;
  const pendingManual = new Map();
  let timer = null;
  let stopped = false;

  function launch(automation, runId) {
    // Nobody is at the keyboard to be turned away, so a disabled or pending
    // owner is checked here: their schedules stop the moment their access does.
    if (automation.userId && (store.users.get(automation.userId)?.status !== 'approved' || !app.ownerFeatures(automation.userId).has('automations'))) {
      store.automations.updateRun(runId, { status: 'skipped', finishedAt: Date.now(), error: 'Owner account is not active.' });
      return true;
    }
    const chat = store.chats.get(automation.chatId, automation.userId);
    if (!chat) {
      store.automations.updateRun(runId, { status: 'failed', finishedAt: Date.now(), error: 'Target chat no longer exists.' });
      return false;
    }
    if (runs.isRunning(chat.id)) return false;
    const firstSeq = store.messages.add(chat.id, { role: 'user', content: runMessage(automation) });
    store.automations.updateRun(runId, { status: 'running', startedAt: Date.now() });
    const role = automation.userId ? store.users.get(automation.userId)?.role : null;
    runs.start({
      chat,
      model: app.modelFor(automation.userId, role),
      tools: app.toolsFor(app.ownerFeatures(automation.userId)),
      historyFromSeq: firstSeq,
      unattended: true,
      onFinish: ({ ok, error, result }) => {
        store.automations.updateRun(runId, {
          status: ok ? 'completed' : 'failed', finishedAt: Date.now(),
          result: String(result || '').slice(0, 200000), error: error ? String(error).slice(0, 1000) : null
        });
        arm();
      }
    });
    return true;
  }

  async function trigger(automation, userId) {
    const owned = store.automations.get(automation.id, userId);
    if (!owned) throw new Error('no such automation');
    const runId = store.automations.addRun(owned.id, Date.now(), 'queued', 'manual');
    if (runs.isRunning(owned.chatId)) {
      const queue = pendingManual.get(owned.chatId) || [];
      queue.push({ automationId: owned.id, userId, runId });
      pendingManual.set(owned.chatId, queue);
      return { runId, status: 'queued', chatId: owned.chatId };
    }
    launch(owned, runId);
    return { runId, status: 'running', chatId: owned.chatId };
  }

  function drain(chatId) {
    if (runs.isRunning(chatId)) return;
    const queue = pendingManual.get(chatId);
    if (!queue?.length) return;
    const next = queue.shift();
    if (!queue.length) pendingManual.delete(chatId);
    const automation = store.automations.get(next.automationId, next.userId);
    if (!automation) {
      store.automations.updateRun(next.runId, { status: 'failed', finishedAt: Date.now(), error: 'Automation no longer exists.' });
      queueMicrotask(() => drain(chatId));
      return;
    }
    if (!launch(automation, next.runId)) {
      const remaining = pendingManual.get(chatId) || [];
      remaining.unshift(next);
      pendingManual.set(chatId, remaining);
      return;
    }
    if (queue.length) pendingManual.set(chatId, queue);
  }

  function refresh() {
    const now = Date.now();
    for (const automation of store.automations.listAll()) {
      if (!automation.enabled) continue;
      // Recompute stale timestamps on startup or after changes without replaying
      // occurrences missed while the process was down.
      if (!automation.nextRunAt || automation.nextRunAt <= now) {
        try { store.automations.update(automation.id, { nextRunAt: nextSchedule(automation.cron, automation.timezone, now) }, automation.userId); }
        catch (err) { store.automations.update(automation.id, { enabled: false, lastStatus: `invalid schedule: ${err.message}` }, automation.userId); }
      }
    }
  }

  function processDue() {
    if (stopped) return;
    const now = Date.now();
    for (const automation of store.automations.due(now)) {
      const scheduledAt = automation.nextRunAt;
      const runId = store.automations.addRun(automation.id, scheduledAt, 'queued');
      let nextRunAt;
      try { nextRunAt = nextSchedule(automation.cron, automation.timezone, scheduledAt); }
      catch (err) {
        store.automations.update(automation.id, { enabled: false, lastStatus: `invalid schedule: ${err.message}`, nextRunAt: null }, automation.userId);
        store.automations.updateRun(runId, { status: 'failed', finishedAt: now, error: err.message });
        continue;
      }
      store.automations.update(automation.id, { nextRunAt }, automation.userId);
      if (runs.isRunning(automation.chatId)) {
        store.automations.updateRun(runId, { status: 'skipped', finishedAt: now, error: 'Target chat was already running.' });
        continue;
      }
      launch(automation, runId);
    }
    arm();
  }

  /** (Re)sets the timer for the next due automation. Call after any change. */
  function arm() {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    refresh();
    const next = store.automations.nextDue();
    if (next == null) { timer = null; return; }
    timer = setTimeout(processDue, Math.max(25, Math.min(2_147_000_000, next - Date.now())));
    timer.unref?.();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  }

  store.automations.recoverRuns();
  return { arm, trigger, drain, stop };
}
