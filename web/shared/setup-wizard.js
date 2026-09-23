/**
 * setup-wizard.js —— **三步开局的纯逻辑**（双端复用；计划书 §8.2 `:255`-`:268`、§11 U02/U03/U04）
 *
 * 为什么单独一层：三步开局的行为要求里有六条是**状态机语义**（前两步零建局、后退保留内容、
 * 单次提交锁、丢响应先查后建、冻结档案与参数、两轴不许混用），它们与具体是桌面还是手机无关。
 * 放进共享模块 ⇒ 一处实现、两处接线、Node 里可直接跑断言（`test/m3-wizard.test.js`）。
 *
 * ── 它复用而不是重写的东西（B12）────────────────────────────────────────────
 *   · `WWDraftStore`（`draft-store.js`）：草稿的**按档案**会话存储、`sanitizeDraft` 去密钥、
 *     `resolveMode`（新草稿默认试玩）、`modeDrift`（不静默切换模式）、`submitGate`（第 3 步之前
 *     不许建局；缺 Key/绑定失效/板子非法给原因与修复入口，**不静默降级**）、`createSubmitLock`。
 *
 * ── 三条容易写错的地方（本模块专门把它们变成结构性防线）──────────────────────
 *   ① **两轴不许混用**：`mode`（'mock' 试玩 / 'real' 真实）与 `participation`（'play' 我当玩家 /
 *      'watch' 纯观战）是两个维度。历史上真发生过把 'play' 送进 `resolveMode()`、被静默回落成
 *      'mock'、于是开局变试玩且身份翻牌遮罩永不出现、全程无异常的缺陷。
 *      本模块的做法：收到越界值**抛 TypeError**（响亮），绝不静默回落；只有"缺省"才回落。
 *   ② **冻结在前，await 在后**：最终提交用的载荷在**进入 await 之前**就从冻结快照拼好，
 *      之后再有人切档/改昵称都影响不到这一局 —— 结构上就不可能"await 创建结果后再去读当前档案"。
 *   ③ **丢响应不自动重建**：`create()` 抛错（超时/断线）时先 `queryExisting()` 查本档案名下已有对局，
 *      如实返回 `unknown: true` + 查到的东西，由上层让用户确认；**绝不**自动重发。
 */
'use strict';
(function (global) {
  const D = (typeof module !== 'undefined' && module.exports && typeof require === 'function')
    ? require('./draft-store')
    : global.WWDraftStore;

  /** 三步（顺序即计划书 §8.2 的表） */
  const STEPS = [
    { id: 'board', label: '板子与规则', hint: '模板、人数、身份组成、板规；高级选项默认折叠' },
    { id: 'players', label: '参与与座位', hint: '玩家/观战、昵称、固定/随机座位、AI 来客说明' },
    { id: 'confirm', label: '确认开局', hint: '档案、板子、人数、座位策略、试玩/真实、模型配置状态' },
  ];
  /** 参与维度（与 mode 维度无关，见文件头 ①） */
  const PARTICIPATIONS = ['play', 'watch'];

  function clone(value) {
    if (value === null || typeof value !== 'object') return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
  }

  /**
   * 两轴的合法性检查（不抛错的版本，便于界面先问一句再决定）。
   * @returns {{ok:boolean, problems:string[], text:string}}
   */
  function assertAxes(input) {
    const i = input || {};
    const problems = [];
    if (i.mode !== undefined && i.mode !== null && !D.MODES.includes(i.mode)) {
      problems.push(`mode 只接受 ${D.MODES.join(' / ')}（收到「${i.mode}」）`
        + ' —— play/watch 属于**参与**维度，两个维度的取值域不能互相顶替');
    }
    if (i.participation !== undefined && i.participation !== null && !PARTICIPATIONS.includes(i.participation)) {
      problems.push(`participation 只接受 ${PARTICIPATIONS.join(' / ')}（收到「${i.participation}」）`
        + ' —— mock/real 属于**模式**维度，两个维度的取值域不能互相顶替');
    }
    return { ok: problems.length === 0, problems, text: problems.join('；') };
  }

  /** 越界即抛（响亮失败；静默回落正是历史缺陷的成因） */
  function assertAxesOrThrow(which, value) {
    if (value === undefined || value === null) return;
    const r = assertAxes({ [which]: value });
    if (!r.ok) throw new TypeError(r.text);
  }

  /** 参与维度：缺省「我当玩家」；给了非法值只回落到默认，**不会**被当成 mode 的取值 */
  function resolveParticipation(input) {
    const p = input && input.participation;
    return PARTICIPATIONS.includes(p) ? p : 'play';
  }

  function draftKey(profileId) {
    return D.setupDraftKey(profileId);
  }

  /**
   * 建一个向导实例。
   * @param {object} opts
   *   storage          会话存储（sessionStorage 或其替身；缺省则不落盘）
   *   profileId        当前档案（草稿按它隔离；切档换实例即可，绝不继承）
   *   ownerNickname    当前档案的展示昵称（提交时进冻结快照）
   *   board            已选板子（对象；含 boardId/playerCount/roles…）
   *   existingMode     既有草稿/正在恢复的对局的模式（决定 B1/B2；不给则读草稿，再不给 ⇒ 试玩）
   *   mode             显式指定模式（必须是 mock/real）
   *   participation    显式指定参与维度（必须是 play/watch）
   *   now              取时间戳（测试可注入）
   */
  function createWizard(opts) {
    const o = opts || {};
    const storage = o.storage || null;
    const profileId = o.profileId || null;
    const ownerNickname = o.ownerNickname || null;
    const now = typeof o.now === 'function' ? o.now : () => Date.now();

    assertAxesOrThrow('mode', o.mode);
    assertAxesOrThrow('participation', o.participation);

    // 读一次本档案自己的草稿（**只读这个档案的键** ⇒ 结构上不可能继承别的档案）
    const saved = storage ? D.readSetupDraft(storage, profileId) : null;
    const seed = saved && typeof saved === 'object' ? clone(saved) : {};
    const seededMode = seed.mode;
    const seededParticipation = seed.participation;
    delete seed.mode;
    delete seed.participation;

    const existingMode = o.existingMode !== undefined ? o.existingMode : seededMode;
    let mode = o.mode !== undefined
      ? o.mode
      : D.resolveMode({ existingMode });
    let participation = o.participation !== undefined
      ? o.participation
      : resolveParticipation({ participation: seededParticipation });
    /** 恢复场景（有既有模式）之后模式不许被静默改掉 */
    const modeOrigin = D.MODES.includes(existingMode) ? existingMode : null;

    let data = Object.assign({}, seed, o.board !== undefined ? { board: clone(o.board) } : {});
    let step = 1;
    let frozen = null;
    let lastResult = null;
    const lock = D.createSubmitLock();

    function persist() {
      if (!storage) return false;
      return D.writeSetupDraft(storage, profileId, Object.assign({}, data, {
        mode, participation, step, updatedAt: now(),
      }));
    }

    function snapshot() {
      return Object.assign({}, clone(data), {
        profileId, ownerNickname, mode, participation, step, steps: STEPS.length, stepId: STEPS[step - 1].id,
      });
    }

    /** 第 1/2 步写输入：只落盘 + 记数据，**不触发任何网络请求**（B6） */
    function set(patch) {
      const p = patch || {};
      assertAxesOrThrow('mode', p.mode);
      assertAxesOrThrow('participation', p.participation);
      // 两条轴的值由闭包持有（不是只塞进 data）：冻结快照与提交载荷都读闭包，
      // 否则"第 2 步把参与改成观战"不会反映到最终提交上（这是本模块自己踩过的坑）。
      if (p.mode !== undefined) {
        const drift = modeOrigin ? D.modeDrift(modeOrigin, p.mode) : null;
        if (drift) throw new Error(drift);   // 恢复中的模式不许被 set 静默改掉（B2）
        mode = p.mode;
      }
      if (p.participation !== undefined) participation = p.participation;
      data = Object.assign({}, data, clone(p));
      persist();
      return api;
    }

    /** 改模式：只有显式 `{explicit:true}` 才允许覆盖既有模式（B2 不静默切换） */
    function setMode(next, flags) {
      assertAxesOrThrow('mode', next);
      const drift = modeOrigin ? D.modeDrift(modeOrigin, next) : null;
      if (drift && !(flags && flags.explicit)) {
        return { ok: false, reason: drift, mode };
      }
      return { ok: true, reason: '', mode: next };
    }

    function goTo(target) {
      const t = Math.max(1, Math.min(STEPS.length, Number(target) || 1));
      step = t;
      persist();                       // 进退都落盘 ⇒ 后退/刷新都不丢内容（B5）
      return { step, stepId: STEPS[step - 1].id };
    }
    // `next()` / `back()` 返回实例本身（可链式：`w.set(…).next().set(…).next()`），
    // 当前步数随时用 `w.step` 读；进退都落盘 ⇒ 后退/刷新都不丢内容（B5）。
    function next() { goTo(step + 1); return api; }
    function back() { goTo(step - 1); return api; }

    /** 冻结：档案 + 全部参数 + owner 展示快照。冻结之后外部怎么变都影响不到这一局 */
    function freeze(extra) {
      const x = extra || {};
      frozen = Object.freeze({
        profileId,
        // 与服务端存档里的字段同名（`game.ownerProfileId`）：交给建局请求时用这个名字，
        // 语义就是"这一局归属哪个档案"，和"现在浏览器选中哪个档案"是两件事。
        ownerProfileId: profileId,
        ownerNicknameSnapshot: x.ownerNickname !== undefined ? x.ownerNickname : ownerNickname,
        board: clone(data.board) || null,
        boardId: data.boardId !== undefined ? data.boardId : (data.board ? data.board.boardId : null),
        playerCount: data.playerCount !== undefined
          ? data.playerCount
          : (data.board && data.board.playerCount !== undefined ? data.board.playerCount : null),
        rules: clone(data.rules) || null,
        participation,
        mode,
        seatStrategy: data.seatStrategy || null,
        mySeat: data.mySeat === undefined ? null : data.mySeat,
        nickname: data.nickname || null,
        modelConfigStatus: x.modelConfigStatus || null,
        frozenAt: now(),
      });
      return frozen;
    }

    /**
     * 最终提交（第 3 步）。
     * @param deps.create         (payload) => Promise<{gameId}>  真正的建局请求
     * @param deps.queryExisting  () => Promise<任意>             查本档案名下已有的对局（B8）
     * @param deps.boardValid / boardReason / hasApiKey / bindingValid  交给 submitGate
     */
    async function commit(deps) {
      const d = deps || {};
      const gate = D.submitGate({
        step,
        steps: STEPS.length,
        mode,
        boardValid: d.boardValid === undefined ? true : d.boardValid,
        boardReason: d.boardReason,
        hasApiKey: d.hasApiKey,
        bindingValid: d.bindingValid,
      });
      if (!gate.allowed) {
        lastResult = { allowed: false, reason: gate.reason, fix: gate.fix, mode: gate.mode, unknown: false };
        return lastResult;
      }
      if (!lock.tryLock()) {
        // 连点：第二次及以后立即失败，**不产生**第二个建局请求（B7）
        lastResult = { allowed: false, reason: '这次提交已经在进行中（单次提交锁：连点不会重复建局）', fix: null, mode, unknown: false };
        return lastResult;
      }
      // 冻结在前、await 在后：载荷此后不再读任何"当前"状态
      const payload = frozen || freeze({ modelConfigStatus: d.modelConfigStatus });
      try {
        const created = await d.create(payload);
        if (storage) D.clearSetupDraft(storage, profileId);   // 建局成功 ⇒ 这份草稿用完即清
        lastResult = {
          allowed: true, unknown: false, mode, fix: null, reason: '',
          gameId: created && (created.gameId || created.id), created,
        };
        return lastResult;
      } catch (e) {
        // 结果不明：先查已有对局，**绝不**自动重发（B8）
        let existing = null;
        let queryError = null;
        try { existing = d.queryExisting ? await d.queryExisting() : null; }
        catch (err) { queryError = String((err && err.message) || err); }
        lock.release();
        lastResult = {
          allowed: false, unknown: true, mode, fix: null, existing, queryError,
          reason: `建局请求的结果不明（${(e && e.message) || e}）：已先查本档案名下已有的对局，`
            + '请确认那局是否存在再决定是否重试 —— 不会自动重建。',
        };
        return lastResult;
      }
    }

    const api = {
      STEPS, PARTICIPATIONS,
      get step() { return step; },
      get stepId() { return STEPS[step - 1].id; },
      get steps() { return STEPS.length; },
      get mode() { return () => mode; },
      get participation() { return () => participation; },
      get data() { return data; },
      get submitLock() { return lock; },
      get frozen() { return frozen; },
      get lastResult() { return lastResult; },
      profileId, ownerNickname,
      modeOf: () => mode,
      participationOf: () => participation,
      set, setMode, next, back, goTo, freeze, commit, snapshot,
      reset() { data = {}; step = 1; frozen = null; lastResult = null; if (storage) D.clearSetupDraft(storage, profileId); return api; },
      persistDraft: persist,
    };
    // `w.mode()` / `w.participation()` 两种写法都要能用（getter 返回函数）
    return api;
  }

  /**
   * 第三步的汇总行（计划书 §8.2：档案、板子、人数、座位策略、试玩/真实、模型配置状态）。
   * 文案里要把"试玩 = 流程脚本、不调用模型"说清楚，不能让人以为已经体验过真实 AI 推理。
   */
  function summarize(snap, deps) {
    const s = snap || {};
    const d = deps || {};
    const modeText = s.mode === 'real'
      ? '真实对局 · 调用模型并按用量计费'
      : '试玩 · 使用流程脚本、不调用模型（不是真实 AI 推理）';
    let modelText;
    if (s.mode !== 'real') modelText = '不需要（试玩不调用模型）';
    else if (d.hasApiKey === false) modelText = '未配置 API Key：请到「设置 · 模型与密钥」补一把（不会自动降级成试玩）';
    else if (d.bindingValid === false) modelText = '模型绑定已失效：请到设置里重新测试并保存绑定（不会自动降级成试玩）';
    else modelText = `已配置${d.model ? `：${d.model}` : ''}`;
    const boardName = (s.board && (s.board.boardName || s.board.boardId)) || s.boardId || '（未选）';
    const n = s.playerCount || (s.board && s.board.playerCount) || null;
    const seats = s.participation === 'watch'
      ? '纯观战（上帝视角，不占座位）'
      : (s.seatStrategy === 'random' || s.mySeat === 'random'
        ? '随机座位（开局时抽，每局不同）'
        : (s.mySeat ? `固定 ${s.mySeat} 号座位` : '固定座位（未指定）'));
    return [
      { key: 'profile', label: '档案', text: `${s.ownerNickname || '（未命名）'}${s.profileId ? ` · ${String(s.profileId).slice(0, 8)}…` : ''}` },
      { key: 'board', label: '板子', text: String(boardName) },
      { key: 'players', label: '人数', text: n ? `${n} 人局` : '（按板子）' },
      { key: 'seats', label: '座位策略', text: seats },
      { key: 'mode', label: '模式', text: modeText },
      { key: 'model', label: '模型配置', text: modelText },
    ];
  }

  const api = {
    STEPS, PARTICIPATIONS,
    assertAxes, resolveParticipation, draftKey, createWizard, summarize,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.WWSetupWizard = api;
})(typeof window !== 'undefined' ? window : globalThis);
