import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { callManageTasks, taskToolDef } from '../src/tools/task_tool.js';

test('task tool creates and updates a persistent checklist scoped to one chat', () => {
  const store = new Store(':memory:');
  try {
    const first = store.createChat({}, null);
    const second = store.createChat({}, null);
    const changes = [];
    const ctx = { store, chatId: first.id, onChange: (tasks) => changes.push(tasks) };
    assert.equal(taskToolDef().function.name, 'manage_tasks');
    const { task } = JSON.parse(callManageTasks({ action: 'add', title: '  Inspect source  ' }, ctx));
    assert.equal(task.title, 'Inspect source');
    assert.equal(task.status, 'pending');
    assert.deepEqual(store.listTasks(second.id), []);
    assert.equal(JSON.parse(callManageTasks({ action: 'update', id: task.id, status: 'completed' }, ctx)).task.status, 'completed');
    assert.equal(changes.length, 2);
    assert.equal(JSON.parse(callManageTasks({ action: 'list' }, ctx)).tasks[0].status, 'completed');
    assert.match(callManageTasks({ action: 'update', id: task.id, status: 'completed' }, { store, chatId: second.id }), /not found/);
    assert.match(callManageTasks({ action: 'add', title: ' ' }, ctx), /Error/);
    store.db.prepare('DELETE FROM chats WHERE id = ?').run(first.id);
    assert.deepEqual(store.listTasks(first.id), []);
  } finally {
    store.close();
  }
});
