import { $ } from '../core/dom.js';

let shown = [];

/**
 * Render the current chat's checklist, with model-created text kept as text.
 * A list that is all done folds down to its heading; the server leaves it out
 * altogether once the next question is asked.
 */
export function renderTasks(tasks = []) {
  shown = tasks;
  const card = $('chatTasks');
  const list = $('taskItems');
  list.replaceChildren();
  card.hidden = !tasks.length;
  if (!tasks.length) return;
  card.open = tasks.some((task) => task.status !== 'completed');
  $('taskCount').textContent = `${tasks.filter((task) => task.status === 'completed').length}/${tasks.length}`;
  for (const task of tasks) {
    const row = document.createElement('li');
    row.className = `task-item task-${task.status}`;
    const mark = document.createElement('span');
    mark.className = 'task-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◐' : '○';
    const title = document.createElement('span');
    title.textContent = task.title;
    row.append(mark, title);
    list.append(row);
  }
}

/** A question is going out: finished tasks are done with, as the server will agree. */
export function dropFinishedTasks() {
  renderTasks(shown.filter((task) => task.status !== 'completed'));
}
