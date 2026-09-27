#!/usr/bin/env node
/**
 * npm run eval:capabilities              deterministic local wire benchmark
 * npm run eval:capabilities -- --live    configured model (billed provider calls)
 *
 * Both modes exercise runChat and both inventories. Offline cache figures are
 * matching serialized-prefix estimates, NOT provider cache hits or billed cost.
 * Live runs report provider totals/cache/cost only where supplied.
 */
import { createServer } from 'node:http';
import { runChat } from '../src/llm.js';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { attributeRequest } from '../src/attribution.js';
const live = process.argv.includes('--live');
const defs = ['memory__recall','web__search'].map((name) => ({ type:'function', function:{name,
  description: `${name === 'memory__recall' ? 'Recall the saved project codename.' : 'Search the public release bulletin using a query.'} ${'Return source-grounded results. '.repeat(50)}`,
  parameters:{ type:'object', properties:{query:{type:'string'}}, required:['query'] } } }));
const tasks = [
  { name:'plain',prompt:'Reply with just HELLO. No tools are needed.',groups:[],calls:[],expected:['HELLO'] },
  { name:'memory',prompt:'Recall my saved project codename using memory and tell me.',groups:['memory'],calls:['memory__recall'],expected:['ORCHID'] },
  { name:'web',prompt:'Search the public release bulletin and tell me its release code.',groups:['web'],calls:['web__search'],expected:['R17'] },
  { name:'both',prompt:'Recall my saved project codename and search the public bulletin. Give me the codename and release code.',groups:['memory','web'],calls:['memory__recall','web__search'],expected:['ORCHID','R17'] },
  { name:'research',prompt:'Search the public bulletin, then search its verification reference, then search the independent confirmation. Report the release code and both confirmations.',groups:['web'],calls:['web__search','web__search','web__search'],expected:['R17','VERIFIED','CONFIRMED'] }
];
const base = live ? loadConfig() : {model:'scripted',systemPrompt:'Use available tools to answer accurately.',maxToolRounds:8};
if (live && !base.apiKey && !/localhost|127\.0\.0\.1/.test(base.baseUrl)) throw new Error('Live benchmark needs a configured endpoint/key.');
const results=[];
for (const task of tasks) for (const lazyCapabilities of [false,true]) {
  const wires=[]; const calls=[];
  let request=0;
  const script = [...(lazyCapabilities && task.groups.length ? [['load_capabilities',{capabilities:task.groups}]]:[]),
    ...task.calls.map((name,i)=>[name,{query:`step ${i+1}`}]),null];
  let srv;
  if (!live) {
    srv=createServer((req,res)=>{
      let raw=''; req.on('data',(d)=>raw+=d);req.on('end',()=>{
        wires.push(JSON.parse(raw)); const step=script[request++];
        const delta=step ? {tool_calls:[{index:0,id:`c${request}`,type:'function',function:{name:step[0],arguments:JSON.stringify(step[1])}}]} : {content:task.expected.join(' ')};
        res.writeHead(200,{'content-type':'text/event-stream'});
        res.end(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise((r)=>srv.listen(0,'127.0.0.1',r));
  }
  const hub={
    routes:new Map(defs.map((t)=>[t.function.name,{server:t.function.name.split('__')[0],tool:t.function.name.split('__')[1]}])),
    servers:{memory:{capabilityDescription:'Recall saved project facts'},web:{capabilityDescription:'Search release bulletins and verify sources'}},
    instructionsBlock:(names)=>names.map((n)=>`## ${n}\n${'Use returned evidence and do not invent facts. '.repeat(100)}`).join('\n\n'),
    isReadOnly:()=>true,
    call:async(name,args)=>{
      calls.push({name,args});
      if (name==='memory__recall') return 'Saved project codename: ORCHID.';
      if (task.name==='research') return [
        'Release code R17. Search for its verification reference next.',
        'Verification reference: VERIFIED. Search for independent confirmation next.',
        'Independent confirmation: CONFIRMED.'
      ][Math.min(calls.filter((c)=>c.name==='web__search').length-1,2)];
      return 'Release code R17.';
    }
  };
  const store=new Store(':memory:'); const chat=store.createChat({title:task.name});
  store.addMessage(chat.id,{role:'user',content:task.prompt});
  let error=null;
  try {
    await runChat({cfg:{...base,lazyCapabilities,...(!live?{baseUrl:`http://127.0.0.1:${srv.address().port}`}:{})},
      store,chatId:chat.id,hub,tools:defs,emit:()=>{},signal:AbortSignal.timeout(180000)});
  } catch(err) { error=err.message; }
  finally { srv?.close(); }
  const assistants=store.messages(chat.id).filter((r)=>r.role==='assistant');
  const usage=assistants.map((r)=>JSON.parse(r.usage_json||'{}'));
  const providerSum=(get)=>{const values=usage.map(get);return values.length&&values.every((v)=>typeof v==='number')?values.reduce((a,b)=>a+b,0):null;};
  let prefix=0,previous='';
  for(const body of wires){
    const serialized=JSON.stringify({tools:body.tools||[],messages:body.messages});
    let i=0;while(i<previous.length&&i<serialized.length&&previous[i]===serialized[i])i++;
    prefix+=Math.floor(i/4);previous=serialized;
  }
  results.push({task:task.name,mode:lazyCapabilities?'lazy':'eager',requests:assistants.length,
    behaviorPass:!error&&task.expected.every((s)=>(assistants.at(-1)?.content||'').includes(s))&&task.calls.every((n)=>calls.filter((c)=>c.name===n).length >= task.calls.filter((x)=>x===n).length),error,
    firstRequestEstimate:wires.length?attributeRequest(wires[0]).estimatedTotal:null,
    totalInputEstimate:usage.reduce((n,u)=>n+(u.attribution?.input.buckets.filter((b)=>b.category!=='provider_delta').reduce((s,b)=>s+b.tokens,0)||0),0),
    matchingPrefixEstimate:live?null:prefix,
    providerInput:providerSum((u)=>u.prompt_tokens??u.input_tokens),providerOutput:providerSum((u)=>u.completion_tokens??u.output_tokens),
    providerCacheRead:providerSum((u)=>u.prompt_tokens_details?.cached_tokens??u.cache_read_input_tokens),
    providerCost:providerSum((u)=>u.cost),toolCalls:calls.length});
  store.db.close();
}
console.log(JSON.stringify({mode:live?'live':'offline',note:live?'Provider cache behavior depends on upstream routing and warm-up; repeat runs.':'Scripted behavior and char/4 prefix estimates only. No claims about real model selection, cache hits, or billing.',results},null,2));
if(results.some((r)=>!r.behaviorPass))process.exitCode=1;
