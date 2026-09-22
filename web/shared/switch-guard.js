/**
 * switch-guard.js — 切档确认 / 归档阻止 / "返回首页 ≠ 终止" 的**纯决策函数**
 * （计划书 §5.2、§8.2 `:264`/`:268`）
 *
 * 计划书原文：
 *   · §5.2「本窗口有未保存资料或笔记时，切档先确认；**其他窗口切档不能直接销毁当前草稿**。」
 *   · §5.2「有未结束对局的 owner 档案不可进入回收站；返回**明确阻止原因**，
 *     **不得悄悄终止对局**。」
 *   · §8.2 `:268`「返回首页不等于终止，终止始终为独立危险操作。」
 *
 * 为什么是纯函数：这三条都是"点一下之后到底发生了什么"的判定，而"点一下"在测试里最难复现
 * （弹窗、焦点、跨窗口 storage 事件）。把判定抽成纯函数后，每条分支都能逐条钉住；
 * DOM 侧只剩"按 action 弹不弹确认框、显不显示提示"。
 */

'use strict';
(function (global) {
  /** 触发方：本窗口自己的切档 | 另一个窗口（同源另一页面）的切档 */
  const SELF = 'self';
  const OTHER_WINDOW = 'other-window';

  /**
   * 切档决策。
   * @param input.dirty  本窗口是否有**未保存的资料或笔记**（草稿在内存/表单里，还没落盘）
   * @param input.source SELF | OTHER_WINDOW（缺省按本窗口处理）
   * @returns {{action:'proceed'|'confirm'|'defer', reason:string}}
   *   proceed —— 没有草稿，直接切；
   *   confirm —— 本窗口有草稿：先问用户（用户确认后才切，草稿由调用方按 §8.2 处理）；
   *   defer   —— **另一个窗口**切的档：不弹窗、不销毁本窗口草稿，只提示"那边切到了 X"。
   *              绝不能因为别的窗口换了档案就把本窗口正在填的内容抹掉。
   */
  function decideSwitch(input) {
    const dirty = !!(input && input.dirty);
    const source = (input && input.source) || SELF;
    if (!dirty) return { action: 'proceed', reason: '' };
    if (source === OTHER_WINDOW) {
      return {
        action: 'defer',
        reason: '另一个窗口切换了当前档案：本窗口未保存的草稿已保留，仍归原档案。',
      };
    }
    return { action: 'confirm', reason: '本窗口还有未保存的资料或笔记，切换档案前需要确认。' };
  }

  /**
   * 归档 / 删除（进回收站）的阻止原因。
   * @param input.unfinished  该档案**未结束**的对局数（owner = 该档案）
   * @param input.usableCount 设备上仍可用的档案数（归档会把当前档案从选择器里隐藏）
   * @returns 阻止原因字符串；`null` = 允许。
   * 优先级：先看"有没有未结束的对局"（这条的后果最重：不能悄悄终止别人的局），
   * 再看"是不是最后一个可用档案"。
   */
  function archiveBlockReason(input) {
    const n = Number((input && input.unfinished) || 0);
    const usable = Number((input && input.usableCount) || 0);
    if (n > 0) {
      return `该档案还有 ${n} 局未结束的对局，不能归档或删除（不会替你终止它们：请先回到该档案结束或显式终止对局）`;
    }
    if (usable <= 1) return '最后一个可用档案不能归档（可先新建一个）';
    return null;
  }

  /**
   * 离开对局页的意图分类（§8.2 `:268`）。
   * 返回首页 / 关闭页面只是**离开**（对局仍在服务端跑着，随时能恢复）；
   * 只有显式的终止动作才是 terminate。判据里没有任何"因为离开了所以算终止"的分支 ——
   * 这正是原文要钉住的那条。
   */
  function leaveIntent(input) {
    const target = (input && input.target) || 'home';
    const terminate = !!(input && input.terminate);
    return {
      target,
      action: terminate ? 'terminate' : 'leave',
      terminates: terminate,
      needsDangerConfirm: terminate,
    };
  }

  const api = { SELF, OTHER_WINDOW, decideSwitch, archiveBlockReason, leaveIntent };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.WWSwitchGuard = api;
})(typeof window !== 'undefined' ? window : globalThis);
