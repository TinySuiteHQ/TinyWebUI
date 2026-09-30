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
