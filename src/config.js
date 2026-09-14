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
  reasoningEffort: 'high',   // 发言类任务思考强度：low=最低 / high=普通（仅两档，max 已移除）
  fastEffort: 'low',         // 快速任务（夜晚行动/投票/警竞等）思考强度：默认最低保流畅
  contextBudget: 12000,      // 单次决策上下文预算（tokens，估算值）：超出按 L2→L1 顺序裁剪
};

// 历史版本默认值/旧建议值：思考模型一上来就被截断，自动提升到新默认
const LEGACY_MAX_TOKENS = new Set([600, 2000, 8000]);
// 旧超时 120s 对高决策量调用太短，熔断后重试更浪费
const LEGACY_TIMEOUT_MS = new Set([120000, 240000]);

// 旧版的 max 档（太慢）已下线 → 迁移为普通 high
const LEGACY_EFFORT = new Set(['max']);

function migrateConfig(data) {
  if (LEGACY_MAX_TOKENS.has(Number(data.maxTokens))) data.maxTokens = DEFAULT_CONFIG.maxTokens;
  if (LEGACY_TIMEOUT_MS.has(Number(data.timeoutMs))) data.timeoutMs = DEFAULT_CONFIG.timeoutMs;
  if (LEGACY_EFFORT.has(String(data.reasoningEffort))) data.reasoningEffort = DEFAULT_CONFIG.reasoningEffort;
  if (LEGACY_EFFORT.has(String(data.fastEffort))) data.fastEffort = DEFAULT_CONFIG.fastEffort;
  // 旧版"上下文压缩阈值"已被分层记忆架构取代（contextBudget）
  if (data.maxContextTokens !== undefined) delete data.maxContextTokens;
  if (data.contextBudget === undefined) data.contextBudget = DEFAULT_CONFIG.contextBudget;
  if (data.fastEffort === undefined) data.fastEffort = DEFAULT_CONFIG.fastEffort;
  if (data.fastMaxTokens === undefined) data.fastMaxTokens = DEFAULT_CONFIG.fastMaxTokens;
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
      for (const k of known) {
        if (partial[k] !== undefined && partial[k] !== null && !(k === 'apiKey' && String(partial[k]).includes('****'))) {
          this.data[k] = partial[k];
        }
      }
      // 清掉已废弃的键，避免旧配置文件里残留
      delete this.data.maxContextTokens;
      fs.writeFileSync(file, JSON.stringify(this.data, null, 2));
      return this.data;
    },
  };
}

module.exports = { DEFAULT_CONFIG, LEGACY_MAX_TOKENS, migrateConfig, createConfig };
