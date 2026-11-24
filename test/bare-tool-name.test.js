// A model sometimes calls an MCP tool by its bare name ("search") instead of
// the namespaced one the tool block shows it ("tinysearch__search"). The
// executor resolves such a name to its only match BEFORE the approval gate,
// so approval, hooks and the call all see the full name, and a name that
// matches nothing is reported unknown without asking anyone to approve it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { McpHub } from '../server/mcp.ts';
import { Store } from '../server/store/index.ts';
import { toolExecutor } from '../server/chat/tool_executor.ts';
import { EVENT } from '../shared/events.ts';
import { declinedResult } from '../shared/declined.ts';

function fn(name) {
  return { type: 'function', function: { name, description: '', parameters: { type: 'object', properties: {} } } };
}

/**
 * A hub as connect() would leave it, with fake clients that record what they
 * were asked to run. `servers` maps server -> { tool: readOnly }.
 */
function fixture(servers) {
  const hub = new McpHub(Object.fromEntries(Object.keys(servers).map((s) => [s, { command: 'x' }])));
  const ran = [];
  for (const [server, tools] of Object.entries(servers)) {
    hub.clients.set(server, {
      getInstructions: () => null,
      callTool: async ({ name }) => { ran.push(`${server}/${name}`); return { content: [{ type: 'text', text: `ran ${server}/${name}` }] }; }
    });
    for (const [tool, readOnly] of Object.entries(tools)) {
      const flat = `${server}__${tool}`;
      hub.routes.set(flat, { server, tool });
      if (readOnly) hub.readOnly.set(flat, true);
      hub.tools.push(fn(flat));
    }
  }
  hub.registerLocal(fn('expand_context'), async () => 'ok', { readOnly: true });
  return { hub, ran };
}

const TINYSEARCH = { tinysearch: { search: true, scrape_urls: true, get_current_datetime: false, write_note: false } };

/** Runs one batch of calls through a fresh executor; returns results, events and approve() calls. */
async function runCalls(hub, names, { cfg = {}, unattended = false, decision = 'deny', offered = null } = {}) {
  const store = new Store(':memory:');
  const chat = store.chats.create({ title: 't' });
  const events = [];
  const asked = [];
  const approve = async (call) => { asked.push(call.name); return decision; };
  const exec = toolExecutor({
    cfg: { toolApproval: 'writes', ...cfg }, chatId: chat.id, store, hub, offered, emit: (e) => events.push(e),
    unattended, approve, askUser: null, footer: () => '', hooks: {}
  });
  const calls = names.map((name, i) => ({ id: `c${i}`, type: 'function', function: { name, arguments: '{}' } }));
  const out = await exec.execute(calls, { round: 0 });
  return { results: out.map((o) => o.message.content), events, asked };
}

test('bare tool name resolves to its only namespaced match', async () => {
  const { hub, ran } = fixture(TINYSEARCH);
  assert.deepEqual(hub.resolve('search'), { name: 'tinysearch__search' });
  const { results, asked } = await runCalls(hub, ['search', 'scrape_urls']);
  assert.deepEqual(ran, ['tinysearch/search', 'tinysearch/scrape_urls']);
  assert.deepEqual(results, ['ran tinysearch/search', 'ran tinysearch/scrape_urls']);
  assert.deepEqual(asked, [], 'read-only tools run without asking, as they would by full name');
});

test('a bare name only resolves among the tools the model was offered', async () => {
  const { hub, ran } = fixture({ ...TINYSEARCH, other: { search: true } });
  // other__search switched off (or out of this model's scope): no longer ambiguous.
  const offered = hub.tools.map((t) => t.function.name).filter((n) => n !== 'other__search' && n !== 'tinysearch__write_note');
  assert.deepEqual(hub.resolve('search', offered), { name: 'tinysearch__search' });
  assert.match(hub.resolve('write_note', offered).error, /^Error: unknown tool "write_note"/);
  const { results, asked } = await runCalls(hub, ['search', 'write_note'], { offered, cfg: { toolApproval: 'all' } });
  assert.deepEqual(ran, []);
  assert.deepEqual(asked, ['tinysearch__search'], 'the offered match is asked for under its full name; the other is unknown');
  assert.match(results[1], /^Error: unknown tool "write_note"/);
  assert.equal(results[0], declinedResult('tinysearch__search'));
});

test('ambiguous bare tool name lists its candidates', async () => {
  const { hub, ran } = fixture({ ...TINYSEARCH, other: { search: true } });
  const { results, asked } = await runCalls(hub, ['search'], { unattended: true });
  assert.equal(ran.length, 0, 'nothing ran');
  assert.deepEqual(asked, []);
  assert.match(results[0], /^Error: unknown tool "search"/);
  assert.ok(results[0].includes('other__search'), results[0]);
  assert.ok(results[0].includes('tinysearch__search'), results[0]);
  assert.ok(!results[0].includes('needs the user\'s approval'), results[0]);
});

test('namespaced tool name routes unchanged', async () => {
  const { hub, ran } = fixture({ ...TINYSEARCH, other: { search: true } });
  assert.deepEqual(hub.resolve('other__search'), { name: 'other__search' });
  assert.deepEqual(hub.resolve('expand_context'), { name: 'expand_context' }, 'built-ins are exact names too');
  const { results, events } = await runCalls(hub, ['tinysearch__search', 'other__search']);
  assert.deepEqual(ran, ['tinysearch/search', 'other/search']);
  assert.deepEqual(results, ['ran tinysearch/search', 'ran other/search']);
  assert.deepEqual(events.filter((e) => e.type === EVENT.TOOL_CALL).map((e) => e.name), ['tinysearch__search', 'other__search']);
});

test('bare name uses the resolved tool\'s approval', async () => {
  const cfg = { autoApproveTools: ['tinysearch__get_current_datetime'] };

  // Unattended: auto-approved under its full name, so the bare call runs.
  {
    const { hub, ran } = fixture(TINYSEARCH);
    const { results, asked } = await runCalls(hub, ['get_current_datetime'], { cfg, unattended: true });
    assert.deepEqual(results, ['ran tinysearch/get_current_datetime']);
    assert.deepEqual(ran, ['tinysearch/get_current_datetime']);
    assert.deepEqual(asked, []);
  }

  // Unattended: a gated tool is refused under its FULL name, not the bare one.
  {
    const { hub, ran } = fixture(TINYSEARCH);
    const { results } = await runCalls(hub, ['write_note'], { cfg, unattended: true });
    assert.deepEqual(ran, []);
    assert.match(results[0], /^Error: "tinysearch__write_note" needs the user's approval/);
  }

  // Interactive: the prompt shows the full name, and "always" covers the full
  // name, so a later call by either spelling in the same turn is not asked again.
  {
    const { hub, ran } = fixture(TINYSEARCH);
    const { events, asked } = await runCalls(hub, ['write_note', 'tinysearch__write_note'], { cfg, decision: 'always' });
    assert.deepEqual(asked, ['tinysearch__write_note']);
    const prompts = events.filter((e) => e.type === EVENT.APPROVAL || e.type === EVENT.APPROVAL_DONE);
    assert.deepEqual(prompts.map((e) => e.name), ['tinysearch__write_note', 'tinysearch__write_note']);
    assert.deepEqual(ran, ['tinysearch/write_note', 'tinysearch/write_note']);
  }
});

test('unknown tool skips approval', async () => {
  for (const unattended of [false, true]) {
    const { hub, ran } = fixture(TINYSEARCH);
    const { results, asked, events } = await runCalls(hub, ['nope'], { cfg: { toolApproval: 'all' }, unattended });
    assert.deepEqual(asked, [], `approve not called (unattended: ${unattended})`);
    assert.ok(!events.some((e) => e.type === EVENT.APPROVAL));
    assert.deepEqual(ran, []);
    assert.match(results[0], /^Error: unknown tool "nope"/);
  }
});
