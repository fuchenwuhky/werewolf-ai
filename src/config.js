/**
 * config.js — 全局配置（默认值、旧配置迁移、加载/保存）
 * 从 server.js 拆出：迁移逻辑可单测。
 */
'use strict';
const fs = require('fs');

const DEFAULT_CONFIG = {
  baseUrl: 'https://open.deepseek.com/v1',
  apiKey: '',
  // 多 Key（keypool）：填了这个就用它，允许逗号/空格/换行分隔多个 Key。
  // 池里有几把 Key 就有几条起始泳道；每把 Key 的泳道数会按**实际可用额度**自适应（见下）。
  // 注意实测结论（docs/fluency-plan.md §1.4）：并发的收益天花板约 -23%，不是"减半"。
  apiKeys: [],
  // 并发泳道数：0 = 自适应（推荐）。此时起始泳道数 = Key 数，之后由调度器按每把 Key 的实际额度自动加减。
  // >0 = 强制总并发上限（同一把 Key 也想试并发时用它，先用 `npm run probe:concurrency` 确认服务商允许）。
  llmChannels: 0,
  // 每把 Key 允许自适应到几条泳道（上限）。被限流会自动砍半 —— 一次 429 至少要赔一次重试延迟，
  // 所以别设太大；4 足以覆盖绝大多数套餐。
  maxChannelsPerKey: 4,
  // 自适应并发（AIMD）：默认开。撞限流就砍半、连续"满载成功"就 +1 ——
  // "这把 Key 到底允许几并发"只有服务商知道，靠实测收敛比靠猜准。关掉则固定成起始泳道数。
  adaptiveConcurrency: true,
  model: 'deepseek-chat',
  // 分层模型（A2）：快速任务（夜晚行动/投票/警竞等结构化微决策）换用更小更快的模型。
  // 留空 = 全部用 model。实测快速任务占调用次数的一大半，但决策空间很小 ——
  // 用大模型跑它们是纯浪费延迟（p50 4s 里大部分是首字前排队）。
  modelFast: '',
  temperature: 0.8,
  // 发言类任务的输出上限：思考模型的 reasoning 计入输出。
  // 实测（6 局真实对局 / 56 次调用，2026-09）：解码占 85%、首字只占 15%，而高思考档的发言
  // 平均输出 3064 tokens、p90 直接顶到 12000 —— 按 30 tokens/s 算，一条发言就是 100s+。
  // 档位表（effort.js）负责按任务给出更小的实际预算，这里是**兜底天花板**：
  // 从 16000 降到 8000，让"思考失控"最多只能烧到 8000 而不是 16000。
  maxTokens: 8000,
  fastMaxTokens: 8000,       // 快速任务（夜晚/投票等）输出上限：低思考强度下够用，降低最坏延迟
  timeoutMs: 360000,         // 硬上限（兜底）：正常情况下不会用到，真正的闸门是下面两个分任务软超时
  // 分任务软超时（A3）：实测发言 p90 34s、微决策 p50 4s，而旧配置让**所有**任务都可能等 6 分钟 ——
  // 一次卡住的发言就能让整局看起来死掉。现在发言给足、微决策压死，超时按"降档重试"处理。
  slowTimeoutMs: 90000,      // 发言/遗言/PK/警上演讲/反思纪要
  fastTimeoutMs: 30000,      // 夜晚行动/投票/警竞/狼聊等结构化微决策
  cacheControl: false,
  // 连接复用（keep-alive）：实测串行 5 次调用从"5 条连接"降到"1 条"，省掉每次约 90ms 的 TCP+TLS 握手。
  // 若所在网络（典型是 Windows 防火墙/代理）会静默掐断空闲连接，可置 false 回到"每次新连接"。
  keepAlive: true,
  // 发言类任务思考强度：low=最低 / medium=中档（默认）/ high=最深。
  // 为什么默认从 high 降到 medium（实测依据，6 局真实对局）：
  //   高思考档的发言平均等 103.6s、单次最长 362s（≈ 撞满 6 分钟硬超时），
  //   而同模型同接口的微决策只要 1.3~8.8s —— 慢的不是模型，是"给发言的思考预算"。
  //   历史遗留的 max 档已下线（迁移为 medium）。
  reasoningEffort: 'medium',
  fastEffort: 'low',         // 快速任务（夜晚行动/投票/警竞等）思考强度：默认最低保流畅
  // info = 按"信息含量"调度思考预算（常规决策降档、关键节点加档，实测 p90 降 7×）；
  // flat = 旧的按任务名一刀切，保留用于 A/B 对比与回滚
  effortPolicy: 'info',
  // 结构化输出：auto = 先试严格 json_schema，服务商不支持则降级 json_object → 纯提示词；
  // off = 从不发 response_format；json_schema = 强制（失败即暴露，不静默降级）
  structuredOutput: 'auto',
  // 反思节流：某天可见事件少于该阈值 → 不发 LLM，用确定性事实骨架代替（快照时间线已含硬事实）
  digestMinEvents: 6,
  // 决策 journal：把每次决策按稳定 key 落盘，断点恢复时命中 → 零重复 LLM 调用（P1-1/P1-2）
  journal: true,
  // 纪要总数上限：超出的最旧纪要丢弃（硬事实仍在局面快照里，不是信息丢失）
  digestKeep: 6,
  contextBudget: 12000,      // 单次决策上下文预算（tokens，估算值）：超出按 L2→L1 顺序裁剪
};

// 历史版本默认值/旧建议值：思考模型一上来就被截断，自动提升到新默认
// 16000 是旧默认（高思考档配套）——思考降到中档后它不再需要，自动收敛到 8000
const LEGACY_MAX_TOKENS = new Set([600, 2000, 8000, 16000]);
// 旧超时 120s 对高决策量调用太短，熔断后重试更浪费
const LEGACY_TIMEOUT_MS = new Set([120000, 240000]);

// 旧版的 max 档（太慢）已下线 → 迁移为普通 high
const LEGACY_EFFORT = new Set(['max']);

/**
 * 节奏档位（P2-6）：把"这一局要多快 / 多省 / 多深"这**一个**用户意图，落成一组内部参数。
 *
 * 为什么不把内部参数逐个摆到设置页：`effortPolicy` / `digestMinEvents` / `digestKeep` / `contextBudget`
 * 是同一件事的四个侧面，让用户分别理解它们是糟糕的界面设计（"反思阈值调 8 还是 6"没人答得上来）。
 * 另外两个开关**故意不暴露**：关掉 `journal` 会让断点恢复重复调用 LLM（烧 token 且可能跑偏），
 * `structuredOutput` 的 auto 已自带 json_schema → json_object → 纯提示词降级，没有需要用户介入的场景。
 *
 * 约定：`standard.values` 必须始终等于 `DEFAULT_CONFIG` 里的出厂默认值（有测试锁死）。
 * 这样"标准局"永远表示"什么都不改"，档位表不会悄悄漂移成另一种默认。
 */
const PACES = {
  fast: {
    label: '快速局',
    desc: '思考强度最低、关键节点不加档、反思更少、上下文与纪要更小 —— 最省 token、最快出结果。适合先跑通流程或额度紧张时。',
    values: { effortPolicy: 'flat', reasoningEffort: 'low', fastEffort: 'low', digestMinEvents: 12, digestKeep: 3, contextBudget: 6000 },
  },
  standard: {
    label: '标准局',
    desc: '出厂默认：中档思考（发言不再动辄等上百秒）+ 按信息含量分配预算，平衡发言质量与速度。',
    values: { effortPolicy: 'info', reasoningEffort: 'medium', fastEffort: 'low', digestMinEvents: 6, digestKeep: 6, contextBudget: 12000 },
  },
  deep: {
    label: '深度局',
    desc: '关键节点更多思考，连夜晚行动也加档，反思更勤、保留更多纪要 —— 最贵最慢，但 AI 最像认真在玩。',
    values: { effortPolicy: 'info', reasoningEffort: 'high', fastEffort: 'high', digestMinEvents: 3, digestKeep: 10, contextBudget: 16000 },
  },
};

/** 档位会动到的配置键（前端据此把"这一档改了什么"如实展示出来） */
const PACE_KEYS = Object.keys(PACES.standard.values);

/**
 * 把档位落成具体参数：只覆盖调用方**没有显式指定**的键。
 * 显式值优先 —— 高级用户手改过的单项不该被档位静默改回去。
 */
function applyPace(data, pace, explicit = new Set()) {
  const p = PACES[pace];
  if (!p) return false; // 非法档位（含前端的 'custom'）一律不生效，绝不写坏配置
  for (const [k, v] of Object.entries(p.values)) if (!explicit.has(k)) data[k] = v;
  return true;
}

/**
 * 反查当前配置属于哪个档位：与任一档位**完全一致**才算该档，否则 'custom'。
 * 前端据此显示"自定义"，不谎报当前处于某档（设置项谎报正是 keepAlive 那次的教训）。
 */
function detectPace(data) {
  for (const [id, p] of Object.entries(PACES)) {
    if (Object.entries(p.values).every(([k, v]) => data[k] === v)) return id;
  }
  return 'custom';
}

/**
 * 解析 Key 池：`apiKeys`（数组）与 `apiKey`（可含逗号/空格/换行的多个 Key）合并去重。
 *
 * 为什么要允许在 apiKey 里写多个：用户手上往往已经有几个 Key，
 * 让他在同一栏里粘贴就能用，比新增一套 UI 更实际；而 `apiKeys` 数组留给未来的设置页。
 * 去重很关键 —— 同一个 Key 填两遍会产生两条"通道"，等于自己撞自己的限流。
 */
function parseApiKeys(cfg) {
  const collect = (v, out) => {
    if (typeof v !== 'string') return out;
    for (const part of v.split(/[\s,;、]+/)) {
      const k = part.trim();
      if (k && !k.includes('****')) out.push(k); // **** 是脱敏占位，不能被当成真 Key
    }
    return out;
  };
  // 顺序决定"槽位 i 用哪个 Key"，而槽位 0 是单 Key 场景唯一会用到的那个 ——
  // 所以 apiKey（主字段）排在 apiKeys 数组前面，别让数组里的第二个 Key 抢了主 Key 的位置。
  const out = collect(cfg && cfg.apiKey, []);
  if (Array.isArray(cfg && cfg.apiKeys)) for (const k of cfg.apiKeys) collect(k, out);
  return [...new Set(out)];
}

/**
 * 实际并发通道数：显式 `llmChannels` 优先（>0），否则跟随 Key 数（至少 1）。
 *
 * 这是**唯一**的通道数来源：调度器按它开通道，引擎按它决定"互不依赖的调用要不要扇出"
 * （`game.parallelLlm`）。两处不能各算一套，否则会出现"调度器有 4 条通道、引擎却还串行"
 * 这种"配了没生效"的静默失效 —— 本项目踩过同一个坑（keepAlive 复选框谎报）。
 */
function resolveChannels(cfg) {
  const explicit = Number(cfg && cfg.llmChannels);
  if (explicit > 0) return Math.floor(explicit);
  return Math.max(1, parseApiKeys(cfg).length);
}

/**
 * 每把 Key 的**起始**泳道数。
 *   · `llmChannels = 0`（默认）→ 1：先按最保守的跑，然后由调度器按实际额度自适应加档。
 *   · `llmChannels > 0` → 把它摊到每把 Key 上（用户强制指定总并发时用）。
 * 起始值刻意保守：宁可让自适应多花几次成功去发现额度，也不要一上来就撞 429。
 */
function perKeyChannels(cfg, keyCount) {
  const explicit = Number(cfg && cfg.llmChannels);
  const n = Math.max(1, Math.floor(Number(keyCount)) || 1);
  if (explicit > 0) return Math.max(1, Math.floor(explicit / n));
  return 1;
}

/**
 * 引擎"能不能扇出互不依赖的调用"。
 *
 * 与旧版 `resolveChannels(cfg) > 1` 的区别：现在**一把 Key 也可能自适应到多条泳道**，
 * 所以只看起始通道数会漏判（单 Key 用户永远不扇出，自适应学到 4 条也用不上）。
 * 因此：起始通道 > 1，或自适应开着（可能涨上去），就允许引擎并发提交 ——
 * 真正的并发度始终由调度器按每把 Key 的实时额度决定，引擎只负责表达"这些调用互不依赖"。
 */
function canFanOut(cfg) {
  if (resolveChannels(cfg) > 1) return true;
  return !(cfg && cfg.adaptiveConcurrency === false);
}

function migrateConfig(data) {
  if (LEGACY_MAX_TOKENS.has(Number(data.maxTokens))) data.maxTokens = DEFAULT_CONFIG.maxTokens;
  if (LEGACY_TIMEOUT_MS.has(Number(data.timeoutMs))) data.timeoutMs = DEFAULT_CONFIG.timeoutMs;
  if (LEGACY_EFFORT.has(String(data.reasoningEffort))) data.reasoningEffort = DEFAULT_CONFIG.reasoningEffort;
  if (LEGACY_EFFORT.has(String(data.fastEffort))) data.fastEffort = DEFAULT_CONFIG.fastEffort;
  // 旧版"上下文压缩阈值"已被分层记忆架构取代（contextBudget）
  if (data.maxContextTokens !== undefined) delete data.maxContextTokens;
  delete data.pace; // 档位是**派生**的（detectPace 算出来的），不落盘，避免配置文件里留一个会过期的意图标签
  if (data.contextBudget === undefined) data.contextBudget = DEFAULT_CONFIG.contextBudget;
  if (data.fastEffort === undefined) data.fastEffort = DEFAULT_CONFIG.fastEffort;
  if (data.fastMaxTokens === undefined) data.fastMaxTokens = DEFAULT_CONFIG.fastMaxTokens;
  if (data.effortPolicy !== 'flat') data.effortPolicy = DEFAULT_CONFIG.effortPolicy; // 缺省与非法值一律走 info
  if (!['auto', 'off', 'json_schema'].includes(data.structuredOutput)) data.structuredOutput = DEFAULT_CONFIG.structuredOutput;
  if (!(Number(data.digestMinEvents) >= 0)) data.digestMinEvents = DEFAULT_CONFIG.digestMinEvents;
  if (!(Number(data.digestKeep) > 0)) data.digestKeep = DEFAULT_CONFIG.digestKeep;
  if (typeof data.journal !== 'boolean') data.journal = DEFAULT_CONFIG.journal;
  if (typeof data.keepAlive !== 'boolean') data.keepAlive = DEFAULT_CONFIG.keepAlive;
  return data;
}

function createConfig(file) {
  return {
    data: { ...DEFAULT_CONFIG },
    /** @returns {{config: object, migrated: boolean}} migrated=true 表示有旧值被自动迁移 */
    load() {
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        const before = JSON.stringify(j);
        const merged = migrateConfig({ ...DEFAULT_CONFIG, ...j });
        const migrated = before !== JSON.stringify({ ...j, ...merged });
        this.data = merged;
        return { config: this.data, migrated };
      } catch (_) {
        this.data = { ...DEFAULT_CONFIG };
        return { config: this.data, migrated: false };
      }
    },
    get() { return this.data; },
    save(partial) {
      const known = Object.keys(DEFAULT_CONFIG);
      const explicit = new Set();
      for (const k of known) {
        if (partial[k] === undefined || partial[k] === null) continue;
        if (k === 'apiKey' && String(partial[k]).includes('****')) continue;
        explicit.add(k);
        // 凭据字段必须清洗：apiKeys 只接受"字符串数组"，去空、去重、去脱敏占位。
        // 前端可能发来换行文本或带空格的粘贴结果；不做这一步就会把 "sk-a\nsk-b" 当成一把 Key 存下去。
        if (k === 'apiKeys') {
          const arr = (Array.isArray(partial[k]) ? partial[k] : [partial[k]])
            .map((v) => String(v == null ? '' : v).trim())
            .filter((v) => v && !v.includes('****'));
          this.data[k] = [...new Set(arr)];
          continue;
        }
        this.data[k] = partial[k];
      }
      // 节奏档位（P2-6）：只有请求里**明确带了 pace** 才展开档位参数。
      // 否则"只改模型名"这类小改动会把用户手工微调过的参数悄悄改回档位值 ——
      // 那正是 keepAlive 复选框谎报那次的同一类坑（写进去的值被静默覆盖）。
      if (partial.pace !== undefined && partial.pace !== null && partial.pace !== '') {
        applyPace(this.data, String(partial.pace), explicit);
      }
      // 清掉已废弃/派生的键，避免旧配置文件里残留
      delete this.data.pace;
      delete this.data.maxContextTokens;
      fs.writeFileSync(file, JSON.stringify(this.data, null, 2));
      return this.data;
    },
  };
}

module.exports = { DEFAULT_CONFIG, PACES, PACE_KEYS, applyPace, detectPace, LEGACY_MAX_TOKENS, migrateConfig, createConfig, parseApiKeys, resolveChannels, perKeyChannels, canFanOut };
