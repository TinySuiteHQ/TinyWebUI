import { $ } from '../core/dom.js';

/** Render the current chat's checklist, with model-created text kept as text. */
export function renderTasks(tasks = []) {
  const card = $('chatTasks');
  const list = $('taskItems');
  list.replaceChildren();
  card.hidden = !tasks.length;
  if (!tasks.length) return;
  $('taskCount').textContent = `${tasks.filter((task) => task.status === 'completed').length}/${tasks.length}`;
  for (const task of tasks) {
    const row = document.createElement('li');
    row.className = `task-item task-${task.status}`;
    const mark = document.createElement('span');
    mark.className = 'task-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◌' : '○';
    const title = document.createElement('span');
    title.textContent = task.title;
    row.append(mark, title);
    list.append(row);
  }
}
