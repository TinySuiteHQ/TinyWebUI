/** A small, chat-scoped checklist that the model can maintain during a task. */
export const MANAGE_TASKS = 'manage_tasks';

export function taskToolDef() {
  return {
    type: 'function',
    function: {
      name: MANAGE_TASKS,
      description: 'Keep a visible checklist for this chat. Create tasks when a request has multiple steps, and update their status as work progresses. This is a checklist, not a scheduled automation.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'update', 'list'] },
          title: { type: 'string', description: 'Short task title for add.' },
          id: { type: 'string', description: 'Task ID returned by add or list, for update.' },
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
    if (typeof args.id !== 'string' || !args.id || !['pending', 'in_progress', 'completed'].includes(args.status)) {
      return 'Error: update requires a valid task id and status.';
    }
    const task = store.chats.updateTask(chatId, args.id, args.status);
    if (!task) return 'Error: task not found in this chat.';
    onChange?.(store.chats.listTasks(chatId));
    return JSON.stringify({ task });
  }
  return 'Error: action must be add, update, or list.';
}
