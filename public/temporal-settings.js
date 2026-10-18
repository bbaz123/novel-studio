/*
 * 时态引擎设置页（temporal-settings）—— 纯 HTML 片段构造器，零依赖，浏览器与 Node 测试共用（UMD）。
 *
 * 为什么把它从故事状态页里拆出来（v1.2.4 方案 §9 / P0F）：
 *   旧 `renderStoryStatePage()` 把「故事状态卡 + 时态引擎卡 + 影响分析 + 逐章重建 + 存量回填」
 *   依次挂进同一个视图，于是打开一页要滚好几屏、写作台被长列表撑开，作者找不到开关在哪。
 *   **UI 拆分不等于数据库迁移**：这里只做视图层级与分组，开关/迁移/重建仍走原有 API 与权限。
 *
 * 纪律：
 *   ① 不靠 `zoom` / `transform: scale()` / 缩小字号解决拥挤（那会损害可读性、让点击区域错位）；
 *   ② 默认只展开**一个**分组，其余 `<details>` 收起；
 *   ③ 分组只是视图，不改任何后端语义（schema_ok / 迁移 / 预算 / 数据可靠性门禁都不动）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelTemporalSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';

  const VERSION = '1.2.4';

  /** 分组定义（顺序即展示顺序；`open` 只允许一个为 true）。 */
  const GROUPS = [
    { id: 'runtime', title: '① 运行状态与开关', note: '引擎是否开启、schema/迁移、可信前缀；三个开关都在这里' },
    { id: 'rebuild', title: '② 影响分析与逐章重建', note: '受影响章节、重建运行记录与预览（候选不覆盖正文）' },
    { id: 'migrate', title: '③ 迁移 / 存量回填 / 校验', note: '逐章冻结与抽取请求、开篇设定候选、故障与校验' },
  ];

  const escOf = (x) => String(x == null ? '' : x)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /** 一个设置分组：原生 `<details>`，默认只开第一个。 */
  function groupHtml({ id, title, note, open = false, body = '' } = {}) {
    const gid = escOf(id);
    return `<details class="ts-group" id="ts-group-${gid}" data-group="${gid}"${open ? ' open' : ''}>
  <summary class="ts-group-summary"><span class="ts-group-title">${escOf(title)}</span>${note ? `<span class="ts-group-note">${escOf(note)}</span>` : ''}</summary>
  <div class="ts-group-body">${body}</div>
</details>`;
  }

  /** 一组分组的完整渲染：只有 `openId` 那一个默认展开。 */
  function groupsHtml(bodies = {}, openId = 'runtime') {
    return GROUPS.map((g) => groupHtml({
      ...g,
      open: g.id === openId,
      body: bodies[g.id] || '<div class="muted">（这一组暂时没有可显示的内容）</div>',
    })).join('\n');
  }

  /** 设置页顶部：一行状态 + 返回入口（返回是普通视图跳转，不是弹窗）。 */
  function headHtml({ statusText = '', backView = 'ai-board' } = {}) {
    return `<div class="ts-head">
  <div class="ts-head-main">
    <h1 class="page-title">⚙ 时态引擎设置</h1>
    <div class="page-sub">${escOf(statusText) || '开关 / 迁移 / 重建 / 回填；这里只改界面层级，不改任何后端语义'}</div>
  </div>
  <div class="ts-head-actions">
    <button class="btn small secondary" data-action="go-view" data-view="${escOf(backView)}">‹ 返回故事状态</button>
  </div>
</div>`;
  }

  /** 故事状态页右上角那个入口（方案 §9.1：「右上：⚙ 时态引擎设置」）。 */
  function entryButtonHtml() {
    return '<button class="btn small secondary" data-action="go-view" data-view="temporal-settings" title="时态引擎的开关、迁移、逐章重建与回填都在独立页面里，不再和角色列表堆在同一页">⚙ 时态引擎设置</button>';
  }

  /**
   * 故事状态页顶部的一行摘要：只放**计数与开关状态**，不放长列表。
   * 长列表留在本页下方或搬进设置页 —— 这一行是给"我现在在哪、引擎开没开"用的。
   */
  function storyStateSummaryHtml(o = {}) {
    const on = o.enabled === true;
    return `<div class="st-summary-line ${on ? 'is-on' : 'is-off'}">
  <span class="st-summary-chip">${on ? '时态引擎已开启' : '时态引擎未开启'}</span>
  <span class="muted">正典事实 ${escOf(Number(o.facts) || 0)} · 时间线 ${escOf(Number(o.timeline) || 0)} · 角色知识 ${escOf(Number(o.knowledge) || 0)} · 待确认提案 ${escOf(Number(o.proposals_pending) || 0)}</span>
</div>`;
  }

  /**
   * 角色紧凑行：默认只给"名字 + 各类计数"，完整状态放在 `<details>` 里按需展开。
   * 这样十几个角色也不会一次占满整屏（方案 §9.1）。
   */
  function characterSummaryHtml(c = {}) {
    const name = escOf(c.name || '未命名角色');
    const counts = `可行动 ${Number(c.actionable) || 0}｜已知 ${Number(c.known) || 0}｜显式不知 ${Number(c.unknown) || 0}｜怀疑 ${Number(c.suspected) || 0}｜误信 ${Number(c.false_beliefs) || 0}｜未定义 ${Number(c.undetermined) || 0}`;
    const abnormal = Number(c.false_beliefs) > 0 || Number(c.suspected) > 0;
    const detail = escOf(c.detail || '');
    return `<details class="st-character-item st-character-compact">
  <summary><b>${name}</b> <span class="muted" style="font-size:12px">${escOf(counts)}</span>${abnormal ? '<span class="chip">有误信/怀疑</span>' : ''}</summary>
  ${detail ? `<div class="muted" style="font-size:12px">${detail}</div>` : '<div class="muted" style="font-size:12px">（选中角色后展开完整掌握清单）</div>'}
</details>`;
  }

  return {
    VERSION,
    GROUPS,
    groupHtml,
    groupsHtml,
    headHtml,
    entryButtonHtml,
    storyStateSummaryHtml,
    characterSummaryHtml,
  };
});
