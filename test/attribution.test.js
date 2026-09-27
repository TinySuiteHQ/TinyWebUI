import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeRequest, completeAttribution, markFinal } from '../src/attribution.js';

test('actual wire content is attributed including structured reasoning and image allowance', () => {
  const systemParts = [{category:'operator',text:'abcd'},{category:'harness',text:'efgh'}];
  const body = {messages:[{role:'system',content:[{type:'text',text:'abcd\n\nefgh'}]},
    {role:'user',content:[{type:'text',text:'user'},{type:'image_url',image_url:{url:'data:xxx'}}]},
    {role:'assistant',content:'past',reasoning_details:[{text:'resent'}],tool_calls:[{function:{name:'read',arguments:'{}'}}]},
    {role:'tool',content:'result'}],tools:[{function:{name:'web__read',description:'read'}}]};
  const snapshot=attributeRequest(body,{systemParts,owner:()=> 'web'});
  for(const category of ['operator','harness','user_messages','image_allowance','assistant_history','reasoning_history','tool_history','tool_results','tool_schemas']) {
    assert.ok(snapshot.buckets.some((b)=>b.category===category),category);
  }
  assert.equal(snapshot.buckets.find((b)=>b.category==='image_allowance').tokens,1500);
  assert.ok(!JSON.stringify(snapshot).includes('data:xxx'));
});

test('provider totals, reasoning and signed deltas are retained without scaling', () => {
  const input=attributeRequest({messages:[{role:'user',content:'x'.repeat(400)}]});
  const snapshot=completeAttribution(input,{prompt_tokens:20,completion_tokens:50,completion_tokens_details:{reasoning_tokens:30}}, {content:'answer',reasoning:'x'.repeat(400)});
  assert.equal(snapshot.input.buckets.find((b)=>b.category==='provider_delta').tokens,-80);
  assert.equal(snapshot.output.buckets.find((b)=>b.category==='reasoning').tokens,30);
  assert.equal(snapshot.output.buckets.find((b)=>b.category==='reasoning').source,'provider');
  for(const side of ['input','output']) assert.equal(snapshot[side].buckets.reduce((n,b)=>n+b.tokens,0),snapshot[side].total);
  assert.ok(markFinal(snapshot).output.buckets.some((b)=>b.category==='final_text'));
  assert.ok(snapshot.output.buckets.some((b)=>b.category==='intermediate_text'));
});

test('missing provider usage stays unknown; absent reasoning is never inferred from total output', () => {
  const snapshot=completeAttribution(attributeRequest({messages:[]}),null,{content:'hi'});
  assert.equal(snapshot.input.total,null); assert.equal(snapshot.output.total,null);
  assert.ok(!snapshot.output.buckets.some((b)=>b.category==='reasoning'||b.category==='provider_delta'));
});
