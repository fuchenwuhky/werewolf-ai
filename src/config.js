/**
 * config.js — 全局配置（默认值、旧配置迁移、加载/保存）
 * 从 server.js 拆出：迁移逻辑可单测。
 */
'use strict';
const fs = require('fs');

const DEFAULT_CONFIG = {
  baseUrl: 'https://open.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.8,
  maxTokens: 16000,          // 发言类任务的输出上限：思考模型的 reasoning 计入输出，起步给足防截断
  fastMaxTokens: 8000,       // 快速任务（夜晚/投票等）输出上限：低思考强度下够用，降低最坏延迟
  timeoutMs: 360000,         // 单次调用上限 6 分钟：开枪/遗言等高决策量调用可能需 150~300s
  cacheControl: false,
  // 连接复用（keep-alive）：实测串行 5 次调用从"5 条连接"降到"1 条"，省掉每次约 90ms 的 TCP+TLS 握手。
  // 若所在网络（典型是 Windows 防火墙/代理）会静默掐断空闲连接，可置 false 回到"每次新连接"。
  keepAlive: true,
  reasoningEffort: 'high',   // 发言类任务思考强度：low=最低 / high=普通（仅两档，max 已移除）
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
const LEGACY_MAX_TOKENS = new Set([600, 2000, 8000]);
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
    desc: '出厂默认：按信息含量分配思考预算（常规决策降档、关键节点加档），平衡发言质量与成本。',
    values: { effortPolicy: 'info', reasoningEffort: 'high', fastEffort: 'low', digestMinEvents: 6, digestKeep: 6, contextBudget: 12000 },
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

module.exports = { DEFAULT_CONFIG, PACES, PACE_KEYS, applyPace, detectPace, LEGACY_MAX_TOKENS, migrateConfig, createConfig };
