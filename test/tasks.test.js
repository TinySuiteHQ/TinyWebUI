import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/index.js';
import { callManageTasks, openTasksNote, taskToolDef } from '../src/tools/task_tool.js';

test('task tool creates and updates a persistent checklist scoped to one chat', () => {
  const store = new Store(':memory:');
  try {
    const first = store.chats.create({}, null);
    const second = store.chats.create({}, null);
    const changes = [];
    const ctx = { store, chatId: first.id, onChange: (tasks) => changes.push(tasks) };
    assert.equal(taskToolDef().function.name, 'manage_tasks');
    const { task } = JSON.parse(callManageTasks({ action: 'add', title: '  Inspect source  ' }, ctx));
    assert.equal(task.title, 'Inspect source');
    assert.equal(task.status, 'pending');
    assert.deepEqual(store.chats.listTasks(second.id), []);
    assert.equal(JSON.parse(callManageTasks({ action: 'update', id: task.id, status: 'completed' }, ctx)).task.status, 'completed');
    assert.equal(changes.length, 2);
    assert.equal(JSON.parse(callManageTasks({ action: 'list' }, ctx)).tasks[0].status, 'completed');
    assert.match(callManageTasks({ action: 'update', id: task.id, status: 'completed' }, { store, chatId: second.id }), /not found/);
    assert.match(callManageTasks({ action: 'add', title: ' ' }, ctx), /Error/);

    const a = JSON.parse(callManageTasks({ action: 'add', title: 'Search' }, ctx)).task;
    const b = JSON.parse(callManageTasks({ action: 'add', title: 'Write up' }, ctx)).task;
    const note = openTasksNote(store.chats.listTasks(first.id));
    assert.match(note, new RegExp(`${a.id} \\[pending\\] Search`));
    assert.doesNotMatch(note, /Inspect source/, 'completed tasks are left out');
    const batch = JSON.parse(callManageTasks({ action: 'update', ids: [a.id, b.id, 'nope'], status: 'completed' }, ctx));
    assert.equal(batch.tasks.length, 2);
    assert.deepEqual(batch.not_found, ['nope']);
    assert.equal(openTasksNote(store.chats.listTasks(first.id)), '', 'nothing open, no note');
    assert.match(callManageTasks({ action: 'update', ids: [], status: 'completed' }, ctx), /Error/);

    store.db.prepare('DELETE FROM chats WHERE id = ?').run(first.id);
    assert.deepEqual(store.chats.listTasks(first.id), []);
  } finally {
    store.close();
  }
});

test('rewinding a chat undoes the checklist writes made from that point on', () => {
  const store = new Store(':memory:');
  try {
    const chat = store.chats.create({}, null);
    const ctx = { store, chatId: chat.id };
    const add = (title) => JSON.parse(callManageTasks({ action: 'add', title }, ctx)).task;
    const set = (id, status) => callManageTasks({ action: 'update', id, status }, ctx);

    store.messages.add(chat.id, { role: 'user', content: 'plan it' });             // seq 0
    const early = add('Early');
    store.messages.add(chat.id, { role: 'assistant', content: 'planned' });         // seq 1
    store.messages.add(chat.id, { role: 'user', content: 'do it' });    // seq 2
    set(early.id, 'in_progress');
    set(early.id, 'completed');
    add('Late');
    store.messages.add(chat.id, { role: 'assistant', content: 'done' });            // seq 3

    store.chats.truncateFrom(chat.id, 2);
    assert.deepEqual(store.chats.listTasks(chat.id).map((t) => [t.title, t.status]), [['Early', 'pending']],
      'the later task is gone and the earlier one is back to its status before the edited question');

    store.chats.truncateFrom(chat.id, 0);
    assert.deepEqual(store.chats.listTasks(chat.id), [], 'rewinding to the start clears the list');
  } finally {
    store.close();
  }
});
