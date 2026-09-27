import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { McpHub, uniqueName } from '../src/mcp.js';
import { capabilitySession } from '../src/capabilities.js';
import { Store } from '../src/store.js';
import { runChat } from '../src/llm.js';
import { createConfigSource } from '../src/config.js';

const def = (name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } });
function hubFixture() {
  const hub = new McpHub({ web: { capabilityDescription: 'Search public pages' }, memory: {} });
  hub.tools = ['web__search', 'memory__recall', 'memory__disabled', 'ask_user'].map(def);
  hub.routes = new Map(hub.tools.slice(0,3).map((t) => [t.function.name, { server: t.function.name.split('__')[0], tool: t.function.name.split('__')[1] }]));
  hub.clients = new Map(['web','memory'].map((name) => [name, { getInstructions: () => `${name} server guidance` }]));
  hub.locals.set('ask_user', () => 'ok');
  hub.readOnly.set('web__search', true);
  hub.calls = [];
  hub.call = async (name) => { hub.calls.push(name); return 'tool result'; };
  return hub;
}

test('capabilities use only authorized inventory, validate atomically, and load idempotently in deterministic order', () => {
  const hub = hubFixture();
  const tools = hub.activeTools(['memory__disabled']);
  const session = capabilitySession({ tools, hub, enabled: true });
  assert.deepEqual(session.tools().map((t) => t.function.name), ['ask_user','load_capabilities']);
  assert.match(session.load({ capabilities: ['web','unknown'] }), /Error/);
  assert.deepEqual(session.servers(), []);
  session.load({ capabilities: ['web','memory','web'] });
  assert.deepEqual(session.servers(), ['memory','web']);
  assert.deepEqual(session.tools().map((t) => t.function.name), ['ask_user','load_capabilities','memory__recall','web__search']);
  const bytes = JSON.stringify(session.tools());
  session.load({ capabilities: ['memory'] });
  assert.equal(JSON.stringify(session.tools()), bytes);
  assert.doesNotMatch(JSON.stringify(session.tools()), /memory__disabled/);
  const restricted = capabilitySession({ tools: [def('ask_user')], hub, enabled: true });
  assert.match(restricted.load({ capabilities: ['web'] }), /Error/);
  assert.deepEqual(restricted.tools().map((t) => t.function.name), ['ask_user']);
});

test('loader is reserved against MCP collisions and config freezing also locks lazy mode', () => {
  assert.notEqual(uniqueName('load_capabilities', new Map()), 'load_capabilities');
  const config = createConfigSource({ configFile: false, config: { frozen: true, lazyCapabilities: true } });
  assert.throws(() => config.save({ lazyCapabilities: false }), /frozen/);
});

async function drive(replies, { cfg = {}, takeInput = null, reportUsage = true } = {}) {
  const hub = hubFixture(); const bodies = [];
  const srv = createServer((req,res) => {
    let body = ''; req.on('data', (d) => body += d); req.on('end', () => {
      bodies.push(JSON.parse(body));
      const reply = replies[Math.min(bodies.length - 1,replies.length - 1)];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = { content: reply.text || '', reasoning: 'thinking',
        ...(reply.calls ? { tool_calls: reply.calls.map(([name,args], index) => ({ index, id: `c${bodies.length}_${index}`, type:'function', function: { name, arguments: JSON.stringify(args) } })) } : {}) };
      res.end(`data: ${JSON.stringify({ choices: [{ delta }], ...(reportUsage ? { usage: { prompt_tokens: 300, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 10 }, prompt_tokens_details: { cached_tokens: 100 } } } : {}) })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((r) => srv.listen(0,'127.0.0.1',r));
  const store = new Store(':memory:'); const chat = store.createChat({ title:'test' });
  store.addMessage(chat.id,{role:'user',content:'do it'});
  const run = () => runChat({ cfg: { baseUrl: `http://127.0.0.1:${srv.address().port}`,model:'test',systemPrompt:'operator',maxToolRounds:8,lazyCapabilities:true,disabledTools:['memory__disabled'],...cfg },
    chatId:chat.id,store,hub,tools:hub.activeTools(['memory__disabled']),emit:()=>{},signal:new AbortController().signal,takeInput });
  try { await run(); } finally { srv.close(); }
  return { bodies,hub,store,chat,rows:store.messages(chat.id) };
}

test('wire starts minimal, refuses premature and disabled calls, adds matching instructions, keeps stable rounds', async () => {
  const { bodies,hub,rows,store,chat } = await drive([
    { calls: [['load_capabilities',{ capabilities:['web'] }],['web__search',{}],['memory__disabled',{}]] },
    { calls: [['web__search',{}]] },
    { calls: [['load_capabilities',{ capabilities:['web'] }]] },
    { text:'final answer' }
  ]);
  assert.doesNotMatch(bodies[0].messages[0].content,/web server guidance|memory server guidance/);
  assert.deepEqual(bodies[0].tools.map((t)=>t.function.name),['ask_user','load_capabilities']);
  assert.match(bodies[1].messages[0].content,/web server guidance/);
  assert.doesNotMatch(bodies[1].messages[0].content,/memory server guidance/);
  assert.equal(JSON.stringify(bodies[1].tools),JSON.stringify(bodies[3].tools));
  assert.equal(bodies[1].messages[0].content,bodies[3].messages[0].content);
  assert.deepEqual(hub.calls,['web__search']);
  const usage = rows.filter((r)=>r.role==='assistant').map((r)=>JSON.parse(r.usage_json));
  assert.equal(usage.length,4);
  assert.ok(usage.at(-1).attribution.output.buckets.some((b)=>b.category==='final_text'));
  assert.ok(!usage[0].attribution.input.buckets.some((b)=>b.category==='mcp_instructions'));
  assert.ok(usage[1].attribution.input.buckets.some((b)=>b.capability==='web'));
  const saved = store.messages(chat.id).at(-1).usage_json;
  hub.clients.get('web').getInstructions=()=> 'changed instructions';
  assert.equal(store.messages(chat.id).at(-1).usage_json,saved);
  const rollup = store.usageRollup(null)[0].models[0];
  assert.equal(rollup.attribution.requests,4);
  assert.equal(rollup.attribution.input.total,1200);
  assert.equal(rollup.attribution.cached,400);
  store.db.close();
});

test('loading does not bypass per-tool approval', async () => {
  const { hub,rows,store } = await drive([
    { calls: [['load_capabilities',{ capabilities:['memory'] }]] },
    { calls: [['memory__recall',{}]] },
    { text:'cannot access memory' }
  ],{cfg:{toolApproval:'all'}});
  assert.deepEqual(hub.calls,[]);
  assert.match(rows.find((r)=>r.role==='tool' && /declined/.test(r.content)).content,/memory__recall/);
  store.db.close();
});

test('steering after visible output leaves earlier text intermediate and only last answer final', async () => {
  let inputs = 0;
  const { rows,store } = await drive([{text:'first'},{text:'second'}],{takeInput:()=>inputs++===0?['also this']:[]});
  const attrs=rows.filter((r)=>r.role==='assistant').map((r)=>JSON.parse(r.usage_json).attribution);
  assert.ok(attrs[0].output.buckets.some((b)=>b.category==='intermediate_text'));
  assert.ok(!attrs[0].output.buckets.some((b)=>b.category==='final_text'));
  assert.ok(attrs[1].output.buckets.some((b)=>b.category==='final_text'));
  store.db.close();
});


test('a provider without usage still stores estimates and does not invent totals', async () => {
  const { rows,store } = await drive([{text:'answer'}],{reportUsage:false});
  const u=JSON.parse(rows.at(-1).usage_json);
  assert.equal(u.prompt_tokens,undefined);
  assert.equal(u.attribution.input.total,null);
  assert.equal(u.attribution.output.total,null);
  assert.ok(u.attribution.output.buckets.some((b)=>b.category==='final_text'));
  assert.equal(store.usageStatistics(null).averageAnswerTokens,null);
  store.db.close();
});

test('new runs reset loaded state and a disabled loader cannot expose deferred tools', () => {
  const hub=hubFixture(); const tools=hub.tools;
  const first=capabilitySession({tools,hub,enabled:true});
  first.load({capabilities:['web']});
  const next=capabilitySession({tools,hub,enabled:true});
  assert.deepEqual(next.servers(),[]);
  const blocked=capabilitySession({tools,hub,enabled:true,loaderDisabled:true});
  assert.deepEqual(blocked.tools().map((t)=>t.function.name),['ask_user']);
  assert.equal(blocked.isLoader('load_capabilities'),false);
});
