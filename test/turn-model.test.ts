// The transcript model (web/src/chat/turn_model.ts) draws a live stream and a
// reopened chat through one path. The invariant that matters: the turn a live
// stream builds and the one replayed from the stored messages are the same,
// timings aside.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENT } from '../shared/events.ts';
import {
  createModel, applyEvent, replay, finishTurn, beginTurn, statusOf,
  type Model, type StreamEvent, type StoredMessage
} from '../web/src/model/turn_model.ts';

function live(events: StreamEvent[]): Model {
  const m = createModel();
  let t = 1000;
  for (const ev of events) applyEvent(m, ev, (t += 100));
  finishTurn(m, (t += 100));
  return m;
}

function replayed(messages: StoredMessage[]): Model {
  const m = createModel();
  replay(m, messages);
  return m;
}

/** What is drawn, without what only a watched turn can know (timings) or bookkeeping ids. */
function drawn(m: Model) {
  return m.items.map((item) => {
    if (item.kind !== 'turn') {
      const { id, ...rest } = item as Record<string, unknown>;
      return rest;
    }
    return {
      answer: item.answer,
      notices: item.notices,
      errors: item.errors,
      usage: item.usage,
      activity: item.activity.map((e) => {
        if (e.kind === 'reasoning') return { kind: e.kind, text: e.text };
        if (e.kind === 'note') return { kind: e.kind, text: e.text };
        if (e.kind === 'usage') return { kind: e.kind, raw: e.raw };
        return { kind: e.kind, id: e.id, name: e.name, arg: e.arg, args: e.args, result: e.result, error: e.error, compacted: e.compacted, state: e.state };
      })
    };
  });
}

const usage = { prompt_tokens: 10, completion_tokens: 5 };

const CASES: { name: string, events: StreamEvent[], messages: StoredMessage[] }[] = [
  {
    name: 'a plain answer',
    events: [
      { type: EVENT.USER, content: 'hi', seq: 1, docs: [], images: [] },
      { type: EVENT.TEXT, delta: 'Hel' }, { type: EVENT.TEXT, delta: 'lo' },
      { type: EVENT.USAGE, usage }
    ],
    messages: [
      { role: 'user', content: 'hi', seq: 1 },
      { role: 'assistant', content: 'Hello', usage }
    ]
  },
  {
    name: 'reasoning, a tool, then the answer',
    events: [
      { type: EVENT.USER, content: 'weather?', seq: 1, docs: [], images: [] },
      { type: EVENT.REASONING, delta: 'look ' }, { type: EVENT.REASONING, delta: 'it up' },
      { type: EVENT.TOOL_CALL, id: 'c1', name: 'web__search', args: { q: 'weather' } },
      { type: EVENT.USAGE, usage },
      { type: EVENT.TOOL_RESULT, id: 'c1', result: 'sunny' },
      { type: EVENT.TEXT, delta: 'It is sunny.' },
      { type: EVENT.USAGE, usage }
    ],
    messages: [
      { role: 'user', content: 'weather?', seq: 1 },
      { role: 'assistant', content: '', reasoning: 'look it up', tool_calls: [{ id: 'c1', function: { name: 'web__search', arguments: '{"q":"weather"}' } }], usage },
      { role: 'tool', tool_call_id: 'c1', content: 'sunny' },
      { role: 'assistant', content: 'It is sunny.', usage }
    ]
  },
  {
    name: 'narration before a tool is demoted into the activity',
    events: [
      { type: EVENT.USER, content: 'do it', seq: 1, docs: [], images: [] },
      { type: EVENT.TEXT, delta: 'Let me check.' },
      { type: EVENT.TOOL_CALL, id: 'c1', name: 'read_document', args: { id: 'd1' } },
      { type: EVENT.TOOL_RESULT, id: 'c1', result: 'Error: missing' },
      { type: EVENT.TEXT, delta: 'Done.' }
    ],
    messages: [
      { role: 'user', content: 'do it', seq: 1 },
      { role: 'assistant', content: 'Let me check.', tool_calls: [{ id: 'c1', function: { name: 'read_document', arguments: '{"id":"d1"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'Error: missing' },
      { role: 'assistant', content: 'Done.' }
    ]
  },
  {
    name: 'whitespace beside tool calls is not prose',
    events: [
      { type: EVENT.USER, content: 'x', seq: 1, docs: [], images: [] },
      { type: EVENT.TEXT, delta: '\n\n' },
      { type: EVENT.TOOL_CALL, id: 'c1', name: 'a', args: {} },
      { type: EVENT.TOOL_RESULT, id: 'c1', result: 'ok', compacted: true },
      { type: EVENT.TEXT, delta: 'fine' }
    ],
    messages: [
      { role: 'user', content: 'x', seq: 1 },
      { role: 'assistant', content: '\n\n', tool_calls: [{ id: 'c1', function: { name: 'a', arguments: '' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok', compacted: true },
      { role: 'assistant', content: 'fine' }
    ]
  },
  {
    name: 'an approval, then a denial',
    events: [
      { type: EVENT.USER, content: 'write', seq: 1, docs: [], images: [] },
      { type: EVENT.TOOL_CALL, id: 'c1', name: 'fs__write', args: { path: '/a' } },
      { type: EVENT.APPROVAL, id: 'c1', name: 'fs__write', args: { path: '/a' } },
      { type: EVENT.APPROVAL_DONE, id: 'c1', name: 'fs__write', decision: 'allow' },
      { type: EVENT.TOOL_RESULT, id: 'c1', result: 'written' },
      { type: EVENT.TOOL_CALL, id: 'c2', name: 'fs__write', args: { path: '/b' } },
      { type: EVENT.APPROVAL, id: 'c2', name: 'fs__write', args: { path: '/b' } },
      { type: EVENT.APPROVAL_DONE, id: 'c2', name: 'fs__write', decision: 'deny' },
      { type: EVENT.TOOL_RESULT, id: 'c2', result: 'The user declined this call to "fs__write", so it was not run.' },
      { type: EVENT.TEXT, delta: 'One done.' }
    ],
    messages: [
      { role: 'user', content: 'write', seq: 1 },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'fs__write', arguments: '{"path":"/a"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'written' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c2', function: { name: 'fs__write', arguments: '{"path":"/b"}' } }] },
      { role: 'tool', tool_call_id: 'c2', content: 'The user declined this call to "fs__write", so it was not run.' },
      { role: 'assistant', content: 'One done.' }
    ]
  },
  {
    name: 'steering mid-run closes the turn above it',
    events: [
      { type: EVENT.USER, content: 'first', seq: 1, docs: [], images: [] },
      { type: EVENT.TOOL_CALL, id: 'c1', name: 'a', args: {} },
      { type: EVENT.TOOL_RESULT, id: 'c1', result: 'r' },
      { type: EVENT.USER, content: 'also this', seq: 4, docs: [], images: [] },
      { type: EVENT.TEXT, delta: 'Both.' }
    ],
    messages: [
      { role: 'user', content: 'first', seq: 1 },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'a', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'r' },
      { role: 'user', content: 'also this', seq: 4 },
      { role: 'assistant', content: 'Both.' }
    ]
  }
];

for (const c of CASES) {
  test(`live and replayed agree: ${c.name}`, () => {
    assert.deepEqual(drawn(live(c.events)), drawn(replayed(c.messages)));
  });
}

test('the answer is only the prose still standing at the end', () => {
  const m = live(CASES[2]!.events);
  const turn = m.items[1];
  assert.equal(turn?.kind, 'turn');
  if (turn?.kind !== 'turn') return;
  assert.equal(turn.answer, 'Done.');
  assert.deepEqual(turn.activity.filter((e) => e.kind === 'note').map((e) => e.kind === 'note' && e.text), ['Let me check.']);
  assert.equal(turn.status, null);
});

test('approvals and questions are pending until the server settles them', () => {
  const m = createModel();
  beginTurn(m);
  applyEvent(m, { type: EVENT.TOOL_CALL, id: 'c1', name: 'fs__write', args: { path: '/a' } });
  applyEvent(m, { type: EVENT.APPROVAL, id: 'c1', name: 'fs__write' });
  assert.equal(m.cur?.pending.length, 1);
  assert.equal(m.cur?.status, 'Waiting for your approval');
  applyEvent(m, { type: EVENT.APPROVAL_DONE, id: 'c1', decision: 'allow' });
  assert.equal(m.cur?.pending.length, 0);

  applyEvent(m, { type: EVENT.TOOL_CALL, id: 'c2', name: 'ask_user', args: { question: 'which?' } });
  applyEvent(m, { type: EVENT.QUESTION, id: 'q1', question: 'which?', choices: ['a', 'b'], allowFreeText: true, deadline: null });
  const q = m.cur?.pending[0];
  assert.equal(q?.kind, 'question');
  assert.equal(q?.kind === 'question' && q.callId, 'c2');
  applyEvent(m, { type: EVENT.QUESTION_DONE, id: 'q1', status: 'timeout' });
  assert.equal(m.cur?.pending.length, 0);
  const s = m.cur?.activity.find((e) => e.kind === 'tool' && e.id === 'c2');
  assert.equal(s?.kind === 'tool' && s.state, 'no answer');
});

test('a turn begun in anticipation leaves nothing behind when nothing landed in it', () => {
  const m = createModel();
  beginTurn(m);
  applyEvent(m, { type: EVENT.CHAT, id: 'abc', title: 'T' });
  applyEvent(m, { type: EVENT.USER, content: 'queued follow-up' });
  finishTurn(m);
  assert.deepEqual(m.items.map((i) => i.kind), ['user']);
  assert.deepEqual(m.chat, { id: 'abc', title: 'T' });
});

test('an error mid-turn stays with its turn, which still settles', () => {
  const m = live([
    { type: EVENT.USER, content: 'go', seq: 1, docs: [], images: [] },
    { type: EVENT.TOOL_CALL, id: 'c1', name: 'a', args: {} },
    { type: EVENT.ERROR, error: 'Stopped.' }
  ]);
  const turn = m.items[1];
  assert.equal(turn?.kind === 'turn' && turn.errors[0], 'Stopped.');
  const s = turn?.kind === 'turn' ? turn.activity[0] : undefined;
  assert.equal(s?.kind === 'tool' && s.state, 'stopped');
});

test('the status line names what a tool does when its name says so', () => {
  assert.equal(statusOf('tinysearch__web_search', { q: 'x' }), 'Searching…');
  assert.equal(statusOf('search_chats', {}), 'Searching your chats…');
  assert.equal(statusOf('read_document', { id: 'report.pdf' }), 'Reading report.pdf…');
  assert.equal(statusOf('ask_user', {}), 'Waiting for your answer');
  assert.equal(statusOf('srv__frobnicate', {}), 'Using frobnicate…');
});

test('narration demoted after its round\'s usage goes back where it was spoken', () => {
  const m = live([
    { type: EVENT.USER, content: 'x', seq: 1, docs: [], images: [] },
    { type: EVENT.REASONING, delta: 'hm' },
    { type: EVENT.TEXT, delta: 'Let me look.' },
    { type: EVENT.USAGE, usage },
    { type: EVENT.TOOL_CALL, id: 'c1', name: 'a', args: {} },
    { type: EVENT.TOOL_RESULT, id: 'c1', result: 'r' },
    { type: EVENT.TEXT, delta: 'Done.' }
  ]);
  const turn = m.items[1];
  assert.deepEqual(turn?.kind === 'turn' && turn.activity.map((e) => e.kind), ['reasoning', 'note', 'usage', 'tool']);
});
