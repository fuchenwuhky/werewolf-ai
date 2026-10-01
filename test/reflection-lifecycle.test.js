'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../src/engine/game');
const { Agent } = require('../src/ai/agent');
const { _internals } = require('../src/engine/flow');
const { DEFAULT_CONFIG } = require('../src/config');
const llm = require('../src/ai/llm');

const logger = {debug() {}, info() {}, warn() {}, error() {}};
const cfg = {...DEFAULT_CONFIG,baseUrl:'http://test.invalid/v1',apiKey:'fake-test-key',model:'test',digestMinEvents:0};

function game() {
  const g = new Game({id:'reflection-lifecycle',seed:51,logger,stepPauseMs:0,
    board:{wolf:3,wolfking:1,seer:1,witch:1,hunter:1,guard:1,villager:4},
    rules:{lastWords:{exiled:true,shotVictim:false}},
    players:Array.from({length:12},(_,i)=>({name:`P${i+1}`})),
    agentFactory:(player,owner)=>new Agent(player,owner,cfg,logger)});
  const roles = ['wolf','hunter','wolf','wolfking','seer','witch','wolf','guard','villager','villager','villager','villager'];
  g.players.forEach((p,i)=>{p.role=roles[i];});
  g.started = true;
  g._shots = [];
  for (const day of [1,2]) {
    g.day=day; g.phase='speech';
    for (let i=0;i<8;i++) g.emit('speech',{actor:i+1,data:{context:'day',text:`第${day}天公开发言${i}`}});
  }
  g.day=4;
  return g;
}

function mockLLM(t, calls, answer) {
  const original = llm.chatCompletion;
  llm.chatCompletion = async (_cfg,messages,options) => {
    calls.push({seat:options.meta.seat,task:options.meta.task,messages});
    const value = answer ? answer(options) : {summary:'存活者纪要',suspicion:{8:20}};
    return {content:JSON.stringify(value),usage:{promptTokens:10,completionTokens:10,cachedTokens:0}};
  };
  t.after(()=>{llm.chatCompletion=original;});
}

function deferred() {
  let resolve;
  const promise = new Promise(r=>{resolve=r;});
  return {promise,resolve};
}

test('日切只让存活且已创建的AI入队，计数与调用座位一致，死人记忆原样保留', async t => {
  const g=game(), calls=[];
  mockLLM(t,calls);
  for (const seat of [1,2,3,4,5,6]) g.agentFor(seat);
  for (const seat of [2,4]) {
    g.player(seat).alive=false;
    const agent=g._agents.get(seat);
    agent.digests.set(1,'出局前的旧纪要'); agent.suspicion={8:70}; agent.lastSeq=5;
  }
  // Defensive case: even if an agent exists for a human seat, do not maintain AI memory for it.
  g.player(6).isHuman=true;
  const deadBefore=g.serializeAgents()[2];
  assert.equal(g.scheduleReflection(2),3);
  assert.equal(g.memory.total,3);
  assert.equal(g.memory.done,0);
  await Promise.all([1,3,5].map(seat=>g._agents.get(seat)._reflecting.get(2)));
  assert.deepEqual(calls.map(c=>c.seat),[1,3,5]);
  assert.equal(g.memory,null);
  assert.deepEqual(g.serializeAgents()[2],deadBefore);
  assert.equal(g._agents.get(4).digests.has(2),false);
  assert.equal(g._agents.get(6).digests.size,0);
  assert.equal(g._agents.has(7),false,'不因批量整理创建新的智能体');
});

test('日切等待只等待存活者，不触碰死者或真人残留的异步纪要', async () => {
  const g=game(), active=deferred();
  let joined=0, deadScheduled=0, humanScheduled=0;
  const abandoned={then() {},catch() {joined++;return Promise.resolve();}};
  g._agents.set(1,{_reflecting:new Map([[2,active.promise]]),scheduleReflection:()=>active.promise});
  g.player(2).alive=false;
  g._agents.set(2,{_reflecting:new Map([[2,abandoned]]),scheduleReflection() {deadScheduled++;return null;}});
  g.player(3).isHuman=true;
  g._agents.set(3,{_reflecting:new Map([[2,abandoned]]),scheduleReflection() {humanScheduled++;return null;}});
  let complete=false;
  const waiting=g.waitReflection(2).then(()=>{complete=true;});
  await Promise.resolve();
  assert.equal(complete,false,'存活者未完成时仍必须等，保留重放确定性');
  assert.equal(g.memory.total,1);
  assert.equal(joined,0);
  assert.equal(deadScheduled,0);
  assert.equal(humanScheduled,0);
  active.resolve(); await waiting;
  assert.equal(complete,true);
  assert.equal(g.memory,null);
});

test('无存活AI或对局已结束时不入队，不留下整理进度残影', () => {
  const g=game();
  let calls=0;
  g._agents.set(2,{scheduleReflection() {calls++;return null;}});
  g.player(2).alive=false;
  g.memory={day:1,total:1,done:0};
  assert.equal(g.scheduleReflection(2),0);
  assert.equal(g.memory,null);
  g.player(2).alive=true; g.finished=true;
  assert.equal(g.scheduleReflection(2),0);
  assert.equal(calls,0);
  assert.equal(g.memory,null);
});

test('旧批次迟到完成不能推进新的存活者进度', async () => {
  const g=game(), first=deferred(), dead=deferred(), second=deferred();
  g._agents.set(1,{scheduleReflection:day=>day===1?first.promise:second.promise});
  g._agents.set(2,{scheduleReflection:()=>dead.promise});
  assert.equal(g.scheduleReflection(1),2);
  g.player(2).alive=false;
  assert.equal(g.scheduleReflection(2),1);
  const current=g.memory;
  dead.resolve(); first.resolve();
  await Promise.all([dead.promise,first.promise]);
  assert.equal(g.memory,current);
  assert.equal(g.memory.done,0);
  second.resolve(); await second.promise;
  assert.equal(g.memory,null);
});

test('Agent直接入口与遗言前惰性补齐都跳过死者，不调用模型、不修改已有记忆', async t => {
  const g=game(), calls=[];
  mockLLM(t,calls);
  const agent=g.agentFor(2);
  agent.digests.set(1,'KEEP_BEFORE_DEATH'); agent.suspicion={3:60}; agent.lastSeq=7;
  g.player(2).alive=false;
  const before=g.serializeAgents()[2];
  assert.equal(agent.scheduleReflection(2),null);
  await agent.ensureDigests();
  assert.equal(calls.length,0);
  assert.deepEqual(g.serializeAgents()[2],before);
  assert.equal(agent._reflecting.size,0);
});

test('真实死亡结算仍能完成遗言、警徽移交和猎人开枪，只调用这三项决策', async t => {
  const g=game(), calls=[];
  const answers={lastwords:{text:'我留下明确的遗言。'},badge_pass:{target:5},shoot:{target:3}};
  mockLLM(t,calls,options=>{
    assert.ok(Object.hasOwn(answers,options.meta.task),`不应额外反思或发起其它调用：${options.meta.task}`);
    return answers[options.meta.task];
  });
  g.player(2).isSheriff=true;
  const agent=g.agentFor(2);
  agent.digests.set(1,'KEEP_BEFORE_DEATH');
  g.phase='vote';
  await _internals.exile(g,2);
  assert.deepEqual(calls.map(c=>c.task),['lastwords','badge_pass','shoot']);
  assert.ok(calls.every(c=>c.messages[1].content.includes('KEEP_BEFORE_DEATH')),'离场决策仍读取旧纪要');
  assert.equal(g.player(2).alive,false);
  assert.equal(g.player(5).isSheriff,true);
  assert.equal(g.player(3).alive,false,'猎人指定目标仍实际出局');
  assert.ok(g.events.some(e=>e.type==='speech'&&e.actor===2&&e.data.context==='lastwords'));
  assert.ok(g.events.some(e=>e.type==='shoot'&&e.actor===2&&e.data.target===3));
  assert.deepEqual([...agent.digests],[[1,'KEEP_BEFORE_DEATH']]);
});

test('恢复后死者纪要和怀疑度不丢，仍不日常整理，赛后复盘照常可用', async t => {
  const g=game(), calls=[];
  mockLLM(t,calls,()=>({lessons:['出局前的判断应核对公开原话。']}));
  const agent=g.agentFor(2);
  agent.digests.set(1,'KEEP_BEFORE_DEATH'); agent.suspicion={3:60}; agent.lastSeq=7;
  g.player(2).alive=false;
  const snapshot=g.markAnchor('night');
  const restored=Game.fromJSON(snapshot,{logger,agentFactory:g.agentFactory,stepPauseMs:0});
  for (const [seat,memory] of Object.entries(snapshot.agentStates)) restored.restoreAgentState(Number(seat),memory);
  const dead=restored.agentFor(2);
  assert.deepEqual(restored.serializeAgents()[2],snapshot.agentStates[2]);
  assert.equal(restored.scheduleReflection(2),0);
  await dead.ensureDigests();
  assert.equal(calls.length,0);
  restored.finished=true; restored.winner='good';
  const lessons=await dead.generateLessons();
  assert.deepEqual(calls.map(c=>c.task),['局终复盘']);
  assert.ok(calls[0].messages[0].content.includes('KEEP_BEFORE_DEATH'));
  assert.equal(lessons.length,1);
  assert.equal(lessons[0].role,'hunter');
  assert.deepEqual(restored.serializeAgents()[2],snapshot.agentStates[2]);
});

test('真实整局日切通知时每个被通知的座位都仍存活', async () => {
  const {runGame}=require('../src/engine/flow');
  const {makeMockAgentFactory}=require('../scripts/mock-agent');
  const g=game(), notified=[];
  const mock=makeMockAgentFactory(g.rnd,{});
  g.rules.sheriff=false;
  g.agentFactory=(player,owner)=>{
    const base=mock(player,owner);
    return {decide:req=>base.decide(req),scheduleReflection(day) {
      notified.push({seat:player.seat,day,alive:owner.player(player.seat).alive});
      return null;
    }};
  };
  // Start a fresh normal game; its seeded engine controls all subsequent deaths.
  g.day=0; g.started=false; g.events=[]; g.seq=0;
  await runGame(g);
  assert.ok(notified.length>0,'至少跨过一次日切');
  assert.ok(notified.every(n=>n.alive),'已经出局的座位不得继续收到日切通知');
  assert.equal(g.finished,true);
  assert.equal(g.memory,null);
});
