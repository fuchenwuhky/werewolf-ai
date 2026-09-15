/**
 * schemas.js — 每任务一份 JSON Schema（response_format: json_schema）
 *
 * 目的：把"输出格式合法"从"提示词祈祷 + 事后校验重试"变成服务商侧的结构约束。
 *
 * 关键收益是 target 的 **enum**：候选座位由引擎算出（已排除出局/自己/非法目标），
 * 模型在结构上就不可能吐出一个不存在的座位号——这正是实测 87 次非法输出的主要来源。
 *
 * 严格模式要求：所有属性都必须出现在 required 里，且 additionalProperties: false。
 * 条件必填（例如"仅白狼王自爆时要 target"）在严格模式里表达不了，
 * 因此一律给默认值由 validatePayload 兜底（它本来就接受 explode:false / target:0）。
 */
'use strict';

const TEXT = { type: 'string' };
const BOOL = { type: 'boolean' };

/** 目标座位：枚举候选；无候选时不加 enum（空 enum 非法），交由校验层兜底 */
function seatProp(seats, { allowZero = false, exclude = null } = {}) {
  const ex = Number(exclude);
  let vals = (seats || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (Number.isInteger(ex)) vals = vals.filter((n) => n !== ex);
  if (allowZero) vals.push(0);
  const uniq = [...new Set(vals)].sort((a, b) => a - b);
  const prop = { type: 'integer' };
  if (uniq.length) prop.enum = uniq;
  return prop;
}

/** 严格对象：所有属性必填 + 不允许额外属性 */
function strictObj(props) {
  return { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false };
}

/** task → { name, build(req, opts) } */
const BUILDERS = {
  // 发言类：可带自爆；白狼王自爆带人的目标必须落在候选座位上（与 validatePayload 的 inCand 严丝合缝）
  speech: (req) => strictObj({ text: TEXT, explode: BOOL, target: seatProp(req.candidates), withdraw: BOOL }),
  sheriff_speech: (req) => strictObj({ text: TEXT, explode: BOOL, target: seatProp(req.candidates), withdraw: BOOL }),
  pk_speech: (req) => strictObj({ text: TEXT, explode: BOOL, target: seatProp(req.candidates) }),
  lastwords: () => strictObj({ text: TEXT }),
  wolf_propose: () => strictObj({ text: TEXT }),
  wolf_say: () => strictObj({ text: TEXT }),

  // 狼队讨论：发言 + 可选刀口建议
  wolf_chat: (req) => strictObj({ text: TEXT, target: seatProp(req.candidates, { allowZero: !!req.allowNone }) }),

  // 单目标选择（夜晚行动 / 投票）
  night_guard: (req) => strictObj({ target: seatProp(req.candidates, { allowZero: !!req.allowNone }) }),
  wolf_kill: (req) => strictObj({ target: seatProp(req.candidates, { allowZero: !!req.allowNone }) }),
  vote: (req) => strictObj({ target: seatProp(req.candidates, { allowZero: !!req.allowNone }) }),
  pk_vote: (req) => strictObj({ target: seatProp(req.candidates, { allowZero: !!req.allowNone }) }),
  sheriff_vote: (req) => strictObj({ target: seatProp(req.candidates, { allowZero: !!req.allowNone }) }),
  seer_check: (req) => strictObj({ target: seatProp(req.candidates) }),
  night_dream: (req) => strictObj({ target: seatProp(req.candidates) }),
  crow_curse: (req) => strictObj({ target: seatProp(req.candidates) }),
  wolfbeauty_charm: (req) => strictObj({ target: seatProp(req.candidates) }),
  admirer_crush: (req) => strictObj({ target: seatProp(req.candidates) }),

  // 女巫：解药布尔 + 毒药目标（无候选，用存活座位）
  witch: (req, o) => strictObj({ antidote: BOOL, poison: seatProp(o.aliveSeats, { allowZero: true }) }),

  // 布尔与枚举类
  sheriff_run: () => strictObj({ run: BOOL }),
  direction: () => strictObj({ direction: { type: 'string', enum: ['cw', 'ccw'] } }),
  // duel=true 时目标必须是"存活且非自己"（0 不合法）→ enum 不得含 0
  duel_check: (req, o) => strictObj({ duel: BOOL, target: seatProp(req.candidates, { exclude: o.seat }) }),
  // 白狼王自爆时目标必须"存活且非自己"；其他角色该字段被忽略 → enum 取存活且非自己即对所有角色安全
  explode_check: (req, o) => strictObj({ explode: BOOL, target: seatProp(o.aliveSeats, { exclude: o.seat }) }),

  // 允许 0（不行动/不移交）
  badge_pass: (req, o) => strictObj({ target: seatProp(o.aliveSeats, { allowZero: true }) }),
  shoot: (req, o) => strictObj({ target: seatProp(o.aliveSeats, { allowZero: true }) }),
};

/**
 * 构造 response_format。
 * @param {string} task 任务名
 * @param {object} request askValidated 的请求（carries candidates / allowNone / canExplode）
 * @param {{aliveSeats?: number[]}} opts
 * @returns {object|null} OpenAI 兼容的 response_format；未知任务返回 null（不加约束）
 */
function schemaFor(task, request = {}, opts = {}) {
  const b = BUILDERS[task];
  if (!b) return null;
  const schema = b(request, { aliveSeats: opts.aliveSeats || [], seat: opts.seat });
  return {
    type: 'json_schema',
    json_schema: { name: `ww_${task}`, strict: true, schema },
  };
}

module.exports = { schemaFor, seatProp, strictObj, BUILDERS };
