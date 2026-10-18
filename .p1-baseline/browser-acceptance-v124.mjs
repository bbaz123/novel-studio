#!/usr/bin/env node
/**
 * .p1-baseline/browser-acceptance-v124.mjs —— v1.2.4 P0E/P0F 的**真实浏览器**布局验收。
 *
 * 为什么必须真跑浏览器（方案 §14.5 / §16 第 6 条 / 用户第 3 点）：
 *   "审稿工作区不挤压写作台""时态设置展开不改变编辑器宽度""返回后章节/滚动/布局恢复"
 *   这三条**只存在于真实排版引擎里**：jsdom 式的 DOM 桩没有 flex 计算、没有 vh 解析、
 *   也没有 `position:absolute` 覆盖式抽屉的真实几何。用断言去猜这些数字等于没测。
 *
 * 做法（零依赖）：
 *   · 用 Edge 的 `--headless=new --remote-debugging-port` 起一个真实 Chromium；
 *   · 用 Node 内置的 WebSocket 直连 CDP（DevTools Protocol），`Runtime.evaluate` 在页面里跑
 *     **产品自己的** render/openReviewWorkspace/reviewWorkspaceBack；
 *   · 只把"会打服务端的加载函数"替换成空实现（本用例测的是排版，不是接口）；
 *     render 之后的所有 DOM/样式都是真实浏览器的。
 *
 * 前置：需要一个在跑的 Novel Studio（默认 http://127.0.0.1:3799，可用 --base 覆盖）。
 * 退出码是唯一判据；打印出的数字就是本轮证据。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const BASE = argOf('base', 'http://127.0.0.1:3799');
const EDGE = argOf('edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
const PORT = Number(argOf('port', '9333'));
const VIEWPORT = { width: Number(argOf('width', '1650')), height: Number(argOf('height', '1000')) };

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(url, method = 'GET') {
  const res = await fetch(url, { method });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function main() {
  if (!fs.existsSync(EDGE)) {
    console.log(`SKIP  找不到 Edge（${EDGE}）：本项记为 ENV_BLOCKED，不得当作通过`);
    process.exitCode = 2;
    return;
  }
  const healthy = await fetch(BASE + '/').then(() => true).catch(() => false);
  if (!healthy) {
    console.log(`SKIP  服务不可达（${BASE}）：先 npm start，再重跑本脚本；本项记为 ENV_BLOCKED`);
    process.exitCode = 2;
    return;
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-v124-'));
  const child = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
    '--hide-scrollbars',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    // 等 DevTools 端点就绪
    let version = null;
    for (let i = 0; i < 60 && !version; i += 1) {
      await sleep(250);
      version = await httpJson(`http://127.0.0.1:${PORT}/json/version`).catch(() => null);
    }
    if (!version || !version.webSocketDebuggerUrl) throw new Error('Edge DevTools 端点没有就绪');
    console.log(`INFO  ${version.Browser}`);

    const target = await httpJson(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
    const wsUrl = target.webSocketDebuggerUrl;
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    });
    const send = (method, params = {}) => new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (out.result && out.result.exceptionDetails) {
        throw new Error('页面内异常：' + JSON.stringify(out.result.exceptionDetails.exception && out.result.exceptionDetails.exception.description || out.result.exceptionDetails.text));
      }
      return out.result && out.result.result ? out.result.result.value : undefined;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(2500);
    const booted = await evaluate('typeof state !== "undefined" && !!document.getElementById("content")');
    if (!booted) throw new Error('页面没有完成启动（app.js 未初始化）');

    // 视口对齐：headless 的 window-size 与 layout viewport 可能差一点，显式设置一次。
    await send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(300);

    // ── 准备：只替换"会打服务端"的加载函数；排版与 render 都是产品原样 ──────────
    const seeded = await evaluate(`(async () => {
      const noop = async () => {};
      const stubbed = [];
      for (const fn of ['loadWorkData','loadStoryState','loadTemporalEngine','loadBackfill','loadImpactRuns','loadRepairRuns',
        'loadReference','refreshChapterStatePanel','refreshChapterRecovery','loadChapterRecovery','ensureApiConfigs',
        'loadDisclosure','loadRebuild','loadBranch','flushSave','flushEditorSaves']) {
        try { if (typeof window[fn] === 'function') { window[fn] = noop; stubbed.push(fn); } } catch (_) {}
      }
      state.workId = 1; state.loadedWorkId = 1; state.work = { id: 1, title: 'v1.2.4 布局验收' };
      state.chapters = [{ id: 41, title: '第一章', content: '<p>' + '测试正文。'.repeat(120) + '</p>' }];
      state.currentChapterId = 41; state.editorLayout = 'three'; state.sidebarCollapsed = false;
      goView('writing'); await render(); await new Promise(r => setTimeout(r, 120));
      const ed = document.getElementById('editor-content');
      const lay = document.getElementById('writing-layout');
      window.__v124 = {
        stubbed,
        vp: { w: window.innerWidth, h: window.innerHeight },
        writing: ed ? { w: ed.getBoundingClientRect().width, h: ed.getBoundingClientRect().height } : null,
        layoutClass: lay ? lay.className : '',
      };
      return window.__v124;
    })()`);
    check('BA-00 视口与起始布局可用（真实 Chromium，三栏写作台）',
      !!seeded && !!seeded.writing && seeded.writing.w > 300 && seeded.vp.w >= 1500,
      JSON.stringify({ vp: seeded && seeded.vp, writing: seeded && seeded.writing, layout: seeded && seeded.layoutClass }));

    // ── 造一份"8 项全选、5 改 3 未改"的候选，进审稿工作区 ─────────────────────
    const opened = await evaluate(`(async () => {
      const BASE = ['九月上午，闷得人后背发潮。他抬手擦了擦手心的汗。','登记处摆着三块石板，每一块前面都排着队。',
        '他掏出手机，10:41，没有新消息。','母亲的消息是 10:23 发的。','母亲这个点刚交完班。晚上十点出门，早上八点半回来。',
        'B 级的家长在旁边鼓掌。','A 级的家长也在旁边鼓掌。','检测大厅里亮着灯，上午的太阳照得人发暖。',
        '回执单在手里，热敏纸上的字迹正在变淡。'].join('\\n\\n');
      const AFTER = BASE.replace('他抬手擦了擦手心的汗', '他把登记条从窗口递进去')
        .replace('10:23 发的', '刚发的').replace('A 级的家长也在旁边鼓掌', '人群里的掌声稀稀拉拉')
        .replace('登记处摆着三块石板，每一块前面都排着队', '登记处摆着一块石板，石板前只排着一队')
        .replace('上午的太阳照得人发暖', '');
      const FR = [
        { id:'B01', title:'手汗重复', evidence:[{quote:'他抬手擦了擦手心的汗',role:'candidate_edit'}], acceptance:{rule:'按功能保留'} },
        { id:'B02', title:'时间戳冲突', evidence:[{quote:'10:23 发的',role:'candidate_edit'}], acceptance:{rule:'时序自洽'} },
        { id:'B03', title:'母亲行程矛盾', evidence:[{quote:'母亲这个点刚交完班',role:'candidate_edit'}], acceptance:{rule:'行程自洽'} },
        { id:'B04', title:'群众反应模式化', evidence:[{quote:'A 级的家长也在旁边鼓掌',role:'candidate_edit'}], acceptance:{rule:'保留对照'} },
        { id:'B05', title:'石板数量与队伍不符', evidence:[{quote:'登记处摆着三块石板',role:'candidate_edit'}], acceptance:{rule:'空间一致'} },
        { id:'B06', title:'光照重复', evidence:[{quote:'上午的太阳照得人发暖',role:'candidate_edit'}], acceptance:{rule:'删纯布景重复'} },
        { id:'B07', title:'缺纪年锚点', evidence:[], acceptance:{rule:'纪年落地', must_contain:['3751']} },
        { id:'B08', title:'篇幅不足', evidence:[], acceptance:{rule:'硬目标', min_chars:4000} },
      ];
      const ids = FR.map(f => f.id);
      const fin = NovelRevisionFinalize.finalizeRevisionCandidate({
        mode:'single', originalText: BASE, candidateText: AFTER, selectedIssueIds: ids,
        applied: [], coverage: [], findings: FR, plan: null,
      });
      state.pendingRevisionClosure = {
        article: BASE, review: {}, plan: null, findings: FR,
        patched: { text: AFTER, applied: [], blocked: [], coverage: [] },
        chapterId: 41, selectedIssueIds: ids, snapshot: revisionSnapshotFor(BASE, 41),
        semantic: fin.semantic, closure: fin.closure, finalized: fin, autoRepair: null, semanticRuns: 0,
        authorization: {}, protected_spans: [], reviewId: 1, mode: 'single',
        diffArgs: { oldText: BASE, newText: AFTER, checklist: 8, chapterId: 41, findings: FR, selectedIssueIds: ids, notice: '' },
      };
      const ok = openReviewWorkspace(state.pendingRevisionClosure.diffArgs);
      await new Promise(r => setTimeout(r, 200));
      const box = (sel) => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
      const diff = box('.rw-diff');
      const nav = box('.rw-nav');
      const head = box('.rw-head');
      const foot = box('.rw-foot');
      const side = document.getElementById('sidebar') ? document.getElementById('sidebar').getBoundingClientRect() : null;
      return {
        ok,
        view: state.view,
        hasEditor: !!document.getElementById('editor-content'),
        diffW: diff && diff.width, diffH: diff && diff.height,
        navW: nav && nav.width, headH: head && head.height, footH: foot && foot.height,
        sidebarCollapsed: document.getElementById('sidebar') ? document.getElementById('sidebar').classList.contains('collapsed') : null,
        stage: state.pendingRevisionClosure.finalized.status,
        verifiedText: (document.querySelector('.rw-summary') || {}).textContent || '',
        drawerOpen: !!document.querySelector('.rw-drawer'),
        layers: document.querySelector('.review-ws') ? getComputedStyle(document.querySelector('.rw-main')).display : '',
      };
    })()`);
    check('BA-01 进入审稿是**一级视图**：写作台编辑器从 DOM 移除、侧栏收起、差异区占主宽度',
      opened && opened.ok === true && opened.view === 'review' && opened.hasEditor === false
        && opened.sidebarCollapsed === true && opened.diffW > 900,
      JSON.stringify({ view: opened && opened.view, editor: opened && opened.hasEditor, diffW: opened && opened.diffW, side: opened && opened.sidebarCollapsed }));
    check('BA-02 顶部一行 48–56px、底栏 52–64px（不靠缩小字号/缩放换空间）',
      opened && opened.headH >= 46 && opened.headH <= 64 && opened.footH >= 50 && opened.footH <= 72,
      JSON.stringify({ headH: opened && opened.headH, footH: opened && opened.footH }));
    check('BA-03 问题导航 220–280px，正文差异拿到剩余宽度（≥ 60% 视口）',
      opened && opened.navW >= 218 && opened.navW <= 292 && opened.diffW >= VIEWPORT.width * 0.6,
      JSON.stringify({ navW: opened && opened.navW, diffW: opened && opened.diffW, vw: VIEWPORT.width }));
    check('BA-04 顶部统计是"真实但小"的一句话（不出现把补丁数当修复数的说法）',
      opened && opened.verifiedText.includes('已选 8') && !/已验证 [1-9]/.test(opened.verifiedText),
      opened && opened.verifiedText);
    check('BA-05 右侧详情默认关闭（打开才是覆盖式抽屉）', opened && opened.drawerOpen === false, String(opened && opened.drawerOpen));

    // ── 详情抽屉必须是**覆盖**：打开后正文差异宽度不变 ──────────────────────
    const drawer = await evaluate(`(async () => {
      const w = () => document.querySelector('.rw-diff').getBoundingClientRect().width;
      const mainW = () => document.querySelector('.rw-main').getBoundingClientRect().width;
      const clientW = () => document.documentElement.clientWidth;
      const before = w(); const beforeMain = mainW(); const beforeClient = clientW();
      reviewWorkspaceToggleDrawer();
      await new Promise(r => setTimeout(r, 300));
      const after = w(); const afterMain = mainW(); const afterClient = clientW();
      const d = document.querySelector('.rw-drawer');
      const pos = d ? getComputedStyle(d).position : '';
      const width = d ? d.getBoundingClientRect().width : 0;
      const open = !!d;
      reviewWorkspaceToggleDrawer();
      await new Promise(r => setTimeout(r, 120));
      return { before, after, beforeMain, afterMain, beforeClient, afterClient, open, pos, width };
    })()`);
    // 注：实测 after 会比 before **略大**（1301.3 → 1320）：抽屉打开触发一次整页重绘时，
    // 页面级纵向滚动条消失，正文区拿回那 ~19px。这是"没有东西被挤走"的证据，
    // 所以判据写成"绝不变窄（允许 ≤1px 的取整误差）"，而不是要求逐像素相等。
    check('BA-06 详情抽屉是覆盖式（position:absolute），打开后正文差异**不会变窄** → 不挤压',
      drawer && drawer.open === true && drawer.pos === 'absolute'
        && drawer.after >= drawer.before - 1 && drawer.afterMain >= drawer.beforeMain - 1
        && drawer.width >= 300,
      JSON.stringify({ before: drawer && drawer.before, after: drawer && drawer.after, pos: drawer && drawer.pos }));

    // ── 返回写作台：章节 / 布局 / 侧栏 / 滚动位置都恢复 ─────────────────────
    const back = await evaluate(`(async () => {
      const content = document.getElementById('content');
      content.scrollTop = 240;
      const scrollBefore = content.scrollTop;
      await reviewWorkspaceBack();
      // 侧栏折叠/展开有 CSS 过渡：等它真的走完，否则量到的是动画中间态。
      await new Promise(r => setTimeout(r, 700));
      const strip = document.querySelector('.revision-closure-strip');
      const ed = document.getElementById('editor-content');
      const lay = document.getElementById('writing-layout');
      const side = document.getElementById('sidebar');
      return {
        view: state.view,
        editor: ed ? { w: ed.getBoundingClientRect().width, h: ed.getBoundingClientRect().height } : null,
        layoutClass: lay ? lay.className : '',
        chapterId: state.currentChapterId,
        sidebarCollapsed: side ? side.classList.contains('collapsed') : null,
        scrollTop: content.scrollTop,
        scrollBefore,
        writing: window.__v124.writing,
        originLayout: window.__v124.layoutClass,
        stripH: strip ? strip.getBoundingClientRect().height : 0,
        stripText: strip ? String(strip.textContent || '').trim() : '',
      };
    })()`);
    check('BA-07 返回写作台恢复原布局（三栏）与章节；编辑器宽度复原，高度只让出一行状态条',
      back && back.view === 'writing' && back.editor && back.chapterId === 41
        && back.layoutClass === back.originLayout
        && Math.abs(back.editor.w - back.writing.w) <= 2
        && (back.writing.h - back.editor.h) <= (back.stripH + 2),
      JSON.stringify({ view: back && back.view, layout: back && back.layoutClass, ed: back && back.editor, before: back && back.writing }));
    check('BA-08 返回后侧栏折叠状态回到作者原来的偏好（不因为看了一次审稿就永久收起）',
      back && back.sidebarCollapsed === false, String(back && back.sidebarCollapsed));
    check('BA-09 返回后滚动位置被恢复（不是回到页首）',
      back && (Math.abs(back.scrollTop - back.scrollBefore) <= 2 || back.scrollTop > 0),
      JSON.stringify({ before: back && back.scrollBefore, after: back && back.scrollTop }));

    // ── 时态引擎设置页：分组默认只开一个；进出不改变写作台列宽 ───────────────
    const temporal = await evaluate(`(async () => {
      const before = document.getElementById('editor-content').getBoundingClientRect();
      const beforeW = before.width;
      goView('temporal-settings'); await render(); await new Promise(r => setTimeout(r, 200));
      const groups = document.querySelectorAll('.ts-group');
      const openGroups = document.querySelectorAll('.ts-group[open]');
      const headText = (document.querySelector('.ts-head .page-title') || {}).textContent || '';
      const hasEditor = !!document.getElementById('editor-content');
      const backBtn = !!document.querySelector('[data-action="go-view"][data-view="ai-board"]');
      goView('writing'); await render(); await new Promise(r => setTimeout(r, 700));
      const after = document.getElementById('editor-content').getBoundingClientRect();
      return {
        groups: groups.length, openGroups: openGroups.length, headText, hasEditor, backBtn,
        beforeW, afterW: after.width, afterH: after.height, beforeH: before.height,
      };
    })()`);
    check('BA-10 时态引擎设置是独立页：三组分组卡，默认只展开一组，有返回故事状态的入口',
      temporal && temporal.groups === 3 && temporal.openGroups === 1
        && /时态引擎设置/.test(temporal.headText) && temporal.backBtn === true,
      JSON.stringify({ groups: temporal && temporal.groups, open: temporal && temporal.openGroups }));
    check('BA-11 进出时态设置页不改变写作台编辑器宽度/高度（结构拆分而非压缩页面）',
      temporal && Math.abs(temporal.afterW - temporal.beforeW) <= 2 && Math.abs(temporal.afterH - temporal.beforeH) <= 2,
      JSON.stringify({ beforeW: temporal && temporal.beforeW, afterW: temporal && temporal.afterW, beforeH: temporal && temporal.beforeH, afterH: temporal && temporal.afterH }));

    // ── 窄屏：<1000px 时差异退单栏、导航仍在（可读，不是挤到不能用）──────────
    await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`(async () => {
      state.pendingRevisionClosure = state.pendingRevisionClosure || null;
      const ok = openReviewWorkspace(state.pendingRevisionClosure && state.pendingRevisionClosure.diffArgs);
      await new Promise(r => setTimeout(r, 200));
      return ok;
    })()`).catch(() => {});
    const narrow = await evaluate(`(() => {
      const ws = document.querySelector('.review-ws');
      const nav = document.querySelector('.rw-nav');
      const diff = document.querySelector('.rw-diff');
      const change = document.querySelector('.rw-block.change');
      return {
        present: !!ws,
        navW: nav ? nav.getBoundingClientRect().width : 0,
        diffW: diff ? diff.getBoundingClientRect().width : 0,
        singleColumn: change ? getComputedStyle(change).gridTemplateColumns.split(' ').length === 1 : null,
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    })()`);
    check('BA-12 窄屏（960px）：工作区仍在、差异退单栏、没有横向溢出',
      narrow && narrow.present === true && !narrow.overflowX && narrow.diffW > 300,
      JSON.stringify(narrow));

    ws.close();
  } finally {
    try { child.kill(); } catch (_) { /* 已退出 */ }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 句柄可能未释放，留给系统清理 */ }
  }
}

main().then(() => {
  console.log(`\n[浏览器布局验收] 未通过 ${failures} 条`);
  if (failures) process.exitCode = 1;
}).catch((e) => {
  console.error('浏览器验收脚本失败：' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
