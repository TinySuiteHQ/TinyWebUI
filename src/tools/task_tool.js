/** A small, chat-scoped checklist that the model can maintain during a task. */
export const MANAGE_TASKS = 'manage_tasks';

export function taskToolDef() {
  return {
    type: 'function',
    function: {
      name: MANAGE_TASKS,
      description: 'Keep a visible checklist for this chat. Create tasks when a request has multiple steps. Mark a task in_progress when you start it and completed as soon as it is done; before your final answer, make sure no finished task is still open. Update several tasks at once with ids. This is a checklist, not a scheduled automation.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'update', 'list'] },
          title: { type: 'string', description: 'Short task title for add.' },
          id: { type: 'string', description: 'Task ID returned by add or list, for update.' },
          ids: { type: 'array', items: { type: 'string' }, description: 'Several task IDs to set to the same status, for update.' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'New status for update.' }
        },
        required: ['action']
      }
    }
  };
}

export function callManageTasks(args, { store, chatId, onChange } = {}) {
  if (!store || !chatId) return 'Error: this tool requires a chat.';
  const { action } = args || {};
  if (action === 'list') return JSON.stringify({ tasks: store.chats.listTasks(chatId) });
  if (action === 'add') {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    if (!title || title.length > 200) return 'Error: title must be 1–200 characters.';
    if (store.chats.listTasks(chatId).length >= 50) return 'Error: this chat has reached the 50-task limit.';
    const task = store.chats.addTask(chatId, title);
    onChange?.(store.chats.listTasks(chatId));
    return JSON.stringify({ task });
  }
  if (action === 'update') {
    const ids = Array.isArray(args.ids) ? args.ids : [args.id];
    if (!ids.length || ids.some((id) => typeof id !== 'string' || !id)
      || !['pending', 'in_progress', 'completed'].includes(args.status)) {
      return 'Error: update requires a valid task id (or ids) and status.';
    }
    const tasks = ids.map((id) => store.chats.updateTask(chatId, id, args.status));
    const missing = ids.filter((_, i) => !tasks[i]);
    if (missing.length === ids.length) return 'Error: task not found in this chat.';
    onChange?.(store.chats.listTasks(chatId));
    if (!Array.isArray(args.ids)) return JSON.stringify({ task: tasks[0] });
    return JSON.stringify({ tasks: tasks.filter(Boolean), ...(missing.length ? { not_found: missing } : {}) });
  }
  return 'Error: action must be add, update, or list.';
}

/**
 * The open checklist, for the budget footer. The model otherwise sees tasks
 * only in the tool results that created them, which scroll out of attention
 * within a turn and are gone from view entirely on the next one.
 */
export function openTasksNote(tasks) {
  const open = (tasks || []).filter((t) => t.status !== 'completed');
  if (!open.length) return '';
  const lines = open.map((t) => `- ${t.id} [${t.status}] ${t.title}`);
  return `\n[Open tasks -- update them with ${MANAGE_TASKS} as you finish each one:\n${lines.join('\n')}]`;
}
