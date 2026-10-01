'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chatCompletion, resetStreamMode } = require('../src/ai/llm');
const { LlmScheduler } = require('../src/ai/scheduler');
const { Game } = require('../src/engine/game');
const { Agent } = require('../src/ai/agent');
const { askValidated } = require('../src/engine/flow')._internals;
const { requestScope, wait } = require('../src/request-scope');
const cfg = {baseUrl:'http://fake.invalid/v1',model:'deepseek-flash',apiKey:'test-key',reasoningEffort:'low',maxTokens:1000,retries:3,adaptiveConcurrency:false};
const silent = {debug(){},info(){},warn(){},error(){}};
const completion = text => new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:text}}]}),{headers:{'Content-Type':'application/json'}});
function fakeFetch(t, fn) {const previous=global.fetch;global.fetch=fn;t.after(()=>{global.fetch=previous;resetStreamMode();});resetStreamMode();}
function game() {
  const g=new Game({id:'deadline-test',board:{wolf:1,seer:1,villager:2},players:Array.from({length:4},(_,i)=>({name:`P${i+1}`,isHuman:false})),logger:silent,
    agentFactory:(p,g)=>new Agent(p,g,cfg,silent)});
  g.deal(); g.day=1; g.phase='speech'; return g;
}
test('响应头已到但 SSE 停滞：硬截止仍中断响应体并释放泳道',async t=>{
  let cancelled=false,calls=0,seenSignal;
  fakeFetch(t,async(_url,options)=>{calls++;seenSignal=options.signal;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"分析"}}]}\n\n'));},cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/event-stream'}});});
  const scheduler=new LlmScheduler(); const started=Date.now();
  await assert.rejects(chatCompletion(cfg,[{role:'user',content:'JSON'}],{scheduler,onDelta(){},deadlineAt:started+100}),e=>e.code==='LLM_DEADLINE');
  await new Promise(r=>setImmediate(r));
  assert.equal(calls,1); assert.equal(cancelled,true); assert.equal(seenSignal.aborted,true); assert.equal(scheduler.busy,false);
  assert.ok(Date.now()-started<1000,'响应体停滞不得无限占用泳道');
});
test('非流式 JSON 响应体永久不结束也受硬截止控制',async t=>{
  fakeFetch(t,async()=>({ok:true,headers:new Headers({'Content-Type':'application/json'}),json:()=>new Promise(()=>{})}));
  const scheduler=new LlmScheduler();
  await assert.rejects(chatCompletion(cfg,[],{scheduler,stream:false,deadlineAt:Date.now()+80}),e=>e.code==='LLM_DEADLINE');
  await new Promise(r=>setImmediate(r)); assert.equal(scheduler.busy,false);
});
test('排队到期立即移除，稍后泳道空闲也不会补发过期请求',async t=>{
  let release,calls=0; const scheduler=new LlmScheduler();
  fakeFetch(t,async()=>{calls++;return completion('{}');});
  const blocker=scheduler.enqueue(()=>new Promise(r=>{release=r;}));
  await assert.rejects(chatCompletion(cfg,[],{scheduler,deadlineAt:Date.now()+80}),e=>e.code==='LLM_DEADLINE');
  assert.equal(scheduler.depth,0); assert.equal(calls,0); release();await blocker;
  assert.equal(calls,0); assert.equal(scheduler.busy,false);
});
test('Retry-After 长退避被截止取消，不再等下一轮重试',async t=>{
  let calls=0;fakeFetch(t,async()=>{calls++;return new Response('{"error":{"message":"limited"}}',{status:429,headers:{'Retry-After':'60'}});});
  const scheduler=new LlmScheduler();const started=Date.now();
  await assert.rejects(chatCompletion(cfg,[],{scheduler,deadlineAt:started+80}),e=>e.code==='LLM_DEADLINE');
  assert.equal(calls,1);assert.ok(Date.now()-started<1000);
});
test('DeepSeek low 失败时补救为 none+disabled，而不是映射回 low 的 minimal',async t=>{
  const bodies=[],statuses=[];
  fakeFetch(t,async(_url,options)=>{const body=JSON.parse(options.body);bodies.push(body);
    return bodies.length===1?new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'',reasoning_content:'分析'}}]}),{headers:{'Content-Type':'application/json'}}):completion('{"text":"按已有发言判断。"}');});
  const budget={remaining:3};
  const out=await chatCompletion(cfg,[],{scheduler:new LlmScheduler(),requestBudget:budget,onStatus:s=>statuses.push(s)});
  assert.equal(out.attempts,2);assert.equal(bodies[0].reasoning_effort,'low');assert.equal(bodies[0].thinking,undefined);
  assert.equal(bodies[1].reasoning_effort,'none');assert.deepEqual(bodies[1].thinking,{type:'disabled'});
  assert.equal(budget.remaining,1);assert.equal(statuses[0].status,'retrying');
});
test('传输失败和校验失败共用最多三个网络请求，不再相乘成九次',async t=>{
  let calls=0;fakeFetch(t,async()=>{calls++;return new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'',reasoning_content:'分析'}}]}),{headers:{'Content-Type':'application/json'}});});
  const g=game();g.decisionTotalMs=1000;
  // 使用实际发言档输出空间，允许底层降档重试，验证其与外层补救共享上限。
  g.agentFor(1).llmCfg={...cfg,maxTokens:16000};
  const out=await askValidated(g,1,{task:'speech'},{fallback:()=>({text:'我过。'})});
  assert.equal(calls,3);assert.equal(out.text,'我过。');assert.equal(g.live,null);
  const notices=g.visibleEvents(2).filter(e=>e.type==='ai_status');assert.equal(notices.length,1);
  assert.deepEqual(Object.keys(notices[0].data).sort(),['message','status']);
  assert.equal(g.events.filter(e=>e.type==='llm_error'&&e.data.transport).length,2);
});
test('校验失败的轻量补救也在共享三次之内，补救成功不用兜底',async t=>{
  let calls=0;fakeFetch(t,async()=>{calls++;return completion(calls===1?'{"text":""}':'{"text":"我站边二号。"}');});
  const g=game(); const out=await askValidated(g,1,{task:'speech'},{fallback:()=>({text:'我过。'})});
  assert.equal(calls,2);assert.equal(out.text,'我站边二号。');assert.equal(g.events.some(e=>e.type==='ai_status'),false);
});
test('前两次传输失败后的补救显示第3次，不错误重置成第2次',async t=>{
  let calls=0;const starts=[];let g;
  fakeFetch(t,async()=>{calls++;starts.push(g.liveFor('god').attempt);
    if(calls<3){const error=new TypeError('connection reset');error.noBackoff=true;throw error;}
    return completion('{"text":"我站边二号。"}');});
  g=game();const out=await askValidated(g,1,{task:'speech'});
  assert.ok(out,JSON.stringify(g.events.filter(e=>e.type==='llm_error')));assert.equal(out.text,'我站边二号。');assert.deepEqual(starts,[1,2,3]);
});
test('记忆准备永久挂起也会被总预算取消，不再发出迟到的决策请求',async t=>{
  let release,calls=0;fakeFetch(t,async()=>{calls++;return completion('{"text":"迟到答案"}');});
  const g=game();g.decisionTotalMs=100;
  g.agentFor(1).ensureDigests=()=>new Promise(resolve=>{release=resolve;});
  const out=await askValidated(g,1,{task:'speech'},{fallback:()=>({text:'我过。'})});
  assert.equal(out.text,'我过。');assert.equal(calls,0);release();
  await new Promise(r=>setImmediate(r));assert.equal(calls,0);assert.equal(g.agentFor(1).turns,0);
});
test('截止后迟到的网络成功结果不能写 journal 或游标、不能替换兜底',async t=>{
  const releases=[];fakeFetch(t,()=>new Promise(resolve=>releases.push(resolve)));
  const g=game();g.decisionTotalMs=100;const agent=g.agentFor(1);let writes=0;
  agent._jwrite=()=>{writes++;};
  const out=await askValidated(g,1,{task:'speech'},{fallback:()=>({text:'我过。'})});
  assert.equal(out.text,'我过。');for(const resolve of releases)resolve(completion('{"text":"迟到答案"}'));
  await new Promise(r=>setImmediate(r));assert.equal(writes,0);assert.equal(agent.lastSeq,0);assert.equal(agent.turns,0);assert.equal(g.live,null);
});
test('永久挂起的 agent 也被总预算中断，迟到的结果不会替换兜底行动',async()=>{
  const g=game();g.decisionTotalMs=100;let calls=0;
  g.ask=async()=>{calls++;return new Promise(()=>{});};
  const started=Date.now(); const out=await askValidated(g,1,{task:'speech'},{fallback:()=>({text:'我过。'})});
  assert.equal(out.text,'我过。');assert.equal(calls,2);assert.ok(Date.now()-started<1000);
});
test('私密决策降级提示仅本人和上帝可见，不公开座位/技能/目标',async t=>{
  fakeFetch(t,async()=>new Response('bad request',{status:400}));const g=game();
  const out=await askValidated(g,1,{task:'vote',candidates:[2,3]},{fallback:()=>({target:2})});
  assert.equal(out.target,2);assert.equal(g.visibleEvents(2).some(e=>e.type==='ai_status'),false);
  const notice=g.visibleEvents(1).find(e=>e.type==='ai_status');assert.deepEqual(notice.visibleTo,[1]);
  assert.deepEqual(Object.keys(notice.data).sort(),['message','status']);
});
test('手动终止立即中断在途和退避，不生成兜底行动/提示',async t=>{
  fakeFetch(t,async(_url,options)=>wait(10000,options.signal));const g=game();
  const result=assert.rejects(askValidated(g,1,{task:'speech'},{fallback:()=>({text:'我过。'})}),e=>e.code==='FORCE_ENDED');
  await new Promise(r=>setTimeout(r,20));g.terminate();await result;
  assert.equal(g.events.some(e=>e.type==='ai_status'),false);
});
test('旧请求结束/增量不能删除或污染同座位的新请求缓冲',()=>{
  const g=game(); const old=g.beginLive({seat:1,task:'speech',public:true}); const current=g.beginLive({seat:1,task:'speech',public:true});
  g.updateLive(old,{content:'旧答案'});g.endLive(old);
  assert.equal(g.live,current);assert.equal(g.liveFor(2).text,'');
  g.setLiveStatus(current,{status:'retrying',attempt:2});const view=g.liveFor(2);
  assert.equal(view.status,'retrying');assert.equal(view.attempt,2);assert.equal(view.reasoning,undefined);
});
test('请求作用域关闭释放超时，已取消的等待立即失败',async()=>{
  const scope=requestScope({deadlineAt:Date.now()+100});scope.close();
  const ctrl=new AbortController();ctrl.abort();
  await assert.rejects(wait(1000,ctrl.signal),e=>e.aborted===true);
  assert.equal(scope.signal.aborted,false);
});
test('同步工作占住事件循环时不能在截止后接受成功结果',async()=>{
  const scope=requestScope({deadlineAt:Date.now()+10});
  try {await assert.rejects(scope.run(()=>{const until=Date.now()+20;while(Date.now()<until){/* 模拟同步工作阻塞定时器。 */}return 'late';}),e=>e.code==='LLM_DEADLINE');}
  finally {scope.close();}
});
