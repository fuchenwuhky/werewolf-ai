/**
 * Manually compare low/disabled reasoning using at most two short paid requests.
 * Usage: node scripts/probe-current-effort.js --live
 * Without --live, no config is read and no request is sent. Never runs on import.
 * Credentials stay in ignored config.json; replies and credential text are never logged.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {buildEndpoint} = require('../src/ai/llm');
async function main(args) {
  if (!args.includes('--live')) {
    console.log('未发送请求。显式传 --live 才会读取本机配置并发出最多两次付费探针。');
    return 2;
  }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf8')); }
  catch (_) { console.error('需要已配置的本机 config.json。'); return 2; }
  if (!cfg.baseUrl || !cfg.model || !cfg.apiKey) {
    console.error('本机配置缺少接口、模型或密钥。');
    return 2;
  }
  let failed = false;
  for (const effort of ['low','none']) {
    const started = Date.now();
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const body = {model:cfg.model,messages:[{role:'user',content:'只输出这个 JSON 对象：{"ok":true}'}],stream:false,max_tokens:1024,reasoning_effort:effort,
        ...(effort==='none' ? {thinking:{type:'disabled'}} : {})};
      const response = await fetch(buildEndpoint(cfg.baseUrl), {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${cfg.apiKey}`},body:JSON.stringify(body),signal:ctrl.signal});
      const raw = await response.json(); const data=raw?.success===true&&raw.data?.choices ? raw.data : raw;
      const choice=data?.choices?.[0]; const message=choice?.message || {};
      console.log(JSON.stringify({effort,http:response.status,ms:Date.now()-started,finish:choice?.finish_reason,
        contentPresent:!!message.content?.trim(),exactAnswer:/"ok"\s*:\s*true/.test(message.content||''),
        reasoningChars:(message.reasoning_content||message.reasoning||'').length,
        completionTokens:data?.usage?.completion_tokens}));
      if (!response.ok || raw?.success === false || raw?.error || !message.content?.trim()) failed = true;
    } catch (error) { failed = true; console.log(JSON.stringify({effort,ms:Date.now()-started,error:error.name==='AbortError'?'timeout':'request_failed'})); }
    finally {clearTimeout(timer);}
  }
  return failed ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; })
    .catch(() => { console.error('probe_failed'); process.exitCode = 1; });
}
