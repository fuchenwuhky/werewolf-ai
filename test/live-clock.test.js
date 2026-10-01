'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const clock = require('../web/shared/connection-state');

test('无需SSE新帧也可计时，刷新首帧沿用服务器开始时间', () => {
  const state = {game:{gameId:'g'}};
  const live = {seat:1,task:'sheriff_speech',startedAt:10000};
  assert.equal(clock.liveSeconds(state,live,null,19000),9);
  assert.equal(clock.liveSeconds(state,live,null,20001),10);
  assert.equal(clock.liveSeconds({},live,null,24000),14);
});

test('同座位同任务新请求、换局、旧帧计时与未来时间戳均不继承错误秒表', () => {
  const state = {game:{gameId:'g'}};
  const live = {seat:1,task:'speech',startedAt:10000};
  assert.equal(clock.liveSeconds(state,live,null,25000),15);
  assert.equal(clock.liveSeconds(state,{...live,startedAt:25000},null,25000),0);
  assert.equal(clock.liveSeconds(state,{seat:1,task:'speech'},null,30000),0);
  assert.equal(clock.liveSeconds(state,{seat:1,task:'speech'},null,32000),2);
  state.game.gameId='other';
  assert.equal(clock.liveSeconds(state,{seat:1,task:'speech'},null,33000),0);
  assert.equal(clock.liveSeconds(state,{...live,startedAt:999999},null,34000),0);
  assert.equal(clock.liveSeconds(state,{...live,startedAt:999999},null,37000),3);
});

test('投票计时与发言分开，投票结束后旧请求起点被清理', () => {
  const state = {liveSince:{key:'previous',at:0}};
  assert.equal(clock.liveSeconds(state,null,20000,25000),5);
  assert.equal(state.liveSince,null);
  assert.equal(clock.liveSeconds(state,null,30000,25000),0);
});

test('本地秒表是单例，结束/停连接会清理，不额外建立轮询', t => {
  const oldSet = global.setInterval, oldClear = global.clearInterval;
  const timers = [], cleared = [];
  global.setInterval = (fn,ms) => { timers.push({fn,ms}); return timers.length; };
  global.clearInterval = id => { cleared.push(id); };
  t.after(()=>{global.setInterval=oldSet;global.clearInterval=oldClear;});
  const state = {};
  let ticks = 0;
  clock.syncLiveClock(state,true,()=>ticks++);
  clock.syncLiveClock(state,true,()=>ticks++);
  assert.equal(timers.length,1);
  assert.equal(timers[0].ms,1000);
  timers[0].fn();
  assert.equal(ticks,1);
  assert.equal(state.pollTimer,undefined);
  clock.syncLiveClock(state,false,()=>ticks++);
  assert.deepEqual(cleared,[1]);
  assert.equal(state.liveClockTimer,null);
  clock.syncLiveClock(state,true,()=>ticks++);
  clock.stopConnection(state,[]);
  assert.deepEqual(cleared,[1,2]);
  assert.equal(state.liveClockTimer,null);
});
