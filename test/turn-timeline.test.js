'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../src/engine/game');
const { taskInstruction } = require('../src/ai/prompts');
const context = require('../src/ai/context');
const { Agent } = require('../src/ai/agent');
const llm = require('../src/ai/llm');
const { DEFAULT_CONFIG } = require('../src/config');
const { resolveBudget, flatBudget } = require('../src/ai/effort');
const { LlmScheduler } = require('../src/ai/scheduler');
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const order = [1,2,3,4,5,6,7,11,12];
const request = extra => ({task:'sheriff_speech', canWithdraw:true, speechRound:'campaign', speechOrder:order, candidates:[1,3,4,5,6,7,8,9,10,11,12], ...extra});

function election() {
  const game = new Game({id:'timeline-test', board:{wolf:3,wolfking:1,seer:1,witch:1,hunter:1,guard:1,villager:4}, players:Array.from({length:12}, (_,i)=>({name:`P${i+1}`})), logger});
  for (const p of game.players) p.role = p.seat === 2 ? 'seer' : p.seat === 12 ? 'wolf' : 'villager';
  game.day = 1;
  game.phase = 'night';
  game.emit('seer_check', {actor:2, visibleTo:[2], data:{target:4,isWolf:false}});
  game.phase = 'sheriff';
  for (const seat of game.aliveSeats()) game.emit('sheriff_run', {actor:seat, data:{run:order.includes(seat)}});
  game.emit('speech', {actor:1, data:{context:'sheriff',text:'九人上警，我先听后置位的查验心路。'}});
  return game;
}

test('复现2号场景：只有1号已说，4号尚未发言，首验不能倒用今天上警', () => {
  const game = election();
  const prompt = taskInstruction(game, game.player(2), request());
  assert.match(prompt, /第1天 · 警上竞选首轮/);
  assert.match(prompt, /本轮已发言：1号。/);
  assert.match(prompt, /本轮其他尚未发言者：3号、4号、5号、6号、7号、11号、12号/);
  assert.match(prompt, /警长投票、当选结果和今天放逐投票尚未发生/);
  assert.match(prompt, /不能用今天上警\/发言\/投票解释昨夜选人/);
  assert.match(prompt, /首夜前没有本局公开发言或票型/);
  assert.match(prompt, /可藏信息，不能改报或多报/);
  assert.match(prompt, /【发言要求】/);
});

test('边界随已发生的发言推进，昨天与私密频道不算本轮已发言', () => {
  const game = election();
  game.emit('wolf_propose', {actor:12, visibleTo:[12], data:{text:'PRIVATE_UNSEEN_SPEECH'}});
  game.emit('speech', {actor:2, data:{context:'sheriff',text:'我报首验4号金水。'}});
  const state = {digests:new Map(), lastSeq:0};
  const text = context.assemble(game, game.player(3), request(), state).text;
  assert.match(text, /本轮已发言：1号、2号。/);
  assert.ok(!text.includes('PRIVATE_UNSEEN_SPEECH'));
  assert.match(text, /本轮其他尚未发言者：4号/);
  game.day = 2;
  assert.match(taskInstruction(game, game.player(3), request()), /本轮已发言：无。/);
});

test('警长平票PK单独计轮次，不把首轮演讲误记为本轮PK发言', () => {
  const game = election();
  game.emit('speech', {actor:7, data:{context:'pk',text:'我来回应首轮的质疑。'}});
  const prompt = taskInstruction(game, game.player(2), request({canWithdraw:false,speechRound:'sheriff_pk',speechOrder:[7,2]}));
  assert.match(prompt, /警长竞选平票 PK/);
  assert.match(prompt, /本轮已发言：7号。/);
  assert.ok(!prompt.includes('本轮已发言：1号'));
  assert.match(prompt, /首轮警长投票已结束；PK 重投尚未发生/);
  assert.match(prompt, /历史发言可引用，但须注明此前轮次/);
});

test('狼人可合法悍跳，时间纪律不等于禁止诈牌', () => {
  const game = election();
  const prompt = taskInstruction(game, game.player(12), request());
  assert.match(prompt, /狼人仍可悍跳、报假查验/);
  assert.match(prompt, /须符合夜次与因果/);
  assert.ok(!prompt.includes('可藏信息，不能改报或多报'));
});

test('首夜择人不鼓励编造尚未发生的发言风格', () => {
  const game = election();
  const prompt = taskInstruction(game, game.player(3), {task:'admirer_crush',candidates:[1,2,4]});
  assert.match(prompt,/首夜尚无公开发言/);
  assert.match(prompt,/不能假称已观察其发言风格/);
});

test('默认以及缺省配置都用low，显式medium/high仍保留', () => {
  for (const cfg of [DEFAULT_CONFIG, {}]) {
    for (const tier of ['minimal','normal','high','critical']) assert.equal(resolveBudget(tier,cfg).effort,'low');
    assert.equal(flatBudget('sheriff_speech',cfg).effort,'low');
    assert.equal(context.taskEffort('speech',cfg),'low');
  }
  assert.equal(resolveBudget('critical',{reasoningEffort:'medium'}).effort,'medium');
  assert.equal(resolveBudget('critical',{reasoningEffort:'high'}).effort,'high');
});

test('真实Agent调用链：低思考与轮次约束一起交给模型，不增加二次润色调用', async t => {
  const game = election();
  const previous = llm.chatCompletion;
  const calls = [];
  llm.chatCompletion = async (cfg,messages,options) => {
    calls.push({cfg,messages,options});
    options.onStart();
    options.onDelta({content:'{"text":"首夜我按座位偏好验4号，金水。其他人还没发言，我先听。"}'});
    return {content:'{"text":"首夜我按座位偏好验4号，金水。其他人还没发言，我先听。"}',usage:{promptTokens:100,completionTokens:50,cachedTokens:0}};
  };
  t.after(()=>{llm.chatCompletion=previous;});
  const agent = new Agent(game.player(2),game,{...DEFAULT_CONFIG,apiKey:'fake-test-key',model:'test'},logger);
  const answer = await agent.decide(request());
  assert.equal(calls.length,1);
  assert.equal(calls[0].options.effort,'low');
  assert.match(calls[0].messages[1].content,/本轮已发言：1号。/);
  assert.match(calls[0].messages[1].content,/不能用今天上警\/发言\/投票解释昨夜选人/);
  assert.match(answer.text,/首夜/);
  assert.equal(game.live,null);
});

test('真实HTTP载荷：默认low实际下发reasoning_effort，不只修改界面标签', async t => {
  const previous = global.fetch;
  const payloads = [];
  global.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"text":"我先听后置位。"}'}}]}), {headers:{'Content-Type':'application/json'}});
  };
  t.after(()=>{global.fetch=previous;});
  await llm.chatCompletion({...DEFAULT_CONFIG,apiKey:'fake-test-key',baseUrl:'http://gateway.invalid/v1',model:'test'},
    [{role:'user',content:'测试'}], {stream:false,scheduler:new LlmScheduler()});
  assert.equal(payloads.length,1);
  assert.equal(payloads[0].reasoning_effort,'low');
  assert.equal(payloads[0].model,'test');
});
