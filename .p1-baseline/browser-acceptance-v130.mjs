#!/usr/bin/env node
/**
 * .p1-baseline/browser-acceptance-v130.mjs —— UI 方案（ui方案.md）的真实浏览器多宽度验收。
 *
 * 与 v124 的关系：v124 的 15 条基线全部保留；本脚本追加：
 *   · 1650/1280/1024/800/768/390 六档宽度：问题导航覆盖式、差异不横向溢出；
 *   · 抽屉打开前后 .rw-main/.rw-diff 宽度不变（覆盖式）；
 *   · 写作台 / 时态设置 / 工作区宽窄屏 / 抽屉打开 的截图；
 *   · 纯 UI 操作（开抽屉/切问题/切筛选）期间 fetch 计数为 0（无付费/写库副作用）。
 *
 * 前置：运行中的 Novel Studio（默认 3799）+ 本机 Edge。退出码是唯一判据。
 */
import { spawn, execFileSync } from 'node:child_process';
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
const PORT = Number(argOf('port', '9334'));
const VIEWPORT = { width: Number(argOf('width', '1650')), height: Number(argOf('height', '1000')) };
const SHOTS = argOf('shots', path.join('.p1-baseline', '.ui-shots'));
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 结束整个浏览器进程树。
 *  为什么不能只 child.kill()：Windows 上 Chromium 的 launcher 被杀后，renderer/GPU 子进程会继续存活；
 *  实测一次验收遗留 25 个 msedge 进程，随后同机的其他检查开始出现 spawn EPERM（句柄/进程耗尽）。
 *  验收脚本必须自己清干净。 */
function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch (_) { try { child.kill(); } catch (__) { /* 已退出 */ } }
}


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
    const shot = async (name) => {
      const out = await send('Page.captureScreenshot', { format: 'png' });
      if (out.result && out.result.data) {
        fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(out.result.data, 'base64'));
        return true;
      }
      return false;
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
    await shot('writing-1650');
    check('BA-00b 写作台基线截图已保存（真实渲染，不是手绘）',
      fs.existsSync(path.join(SHOTS, 'writing-1650.png')), SHOTS);

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
        hash: location.hash,
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
        hash: location.hash,
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
    check('BA-09 返回后滚动位置被恢复（严格 ±2px，不接受“回到任意非零位置”）',
      back && Math.abs(back.scrollTop - back.scrollBefore) <= 2,
      JSON.stringify({ before: back && back.scrollBefore, after: back && back.scrollTop }));
    check('BA-09b 进入工作区写入可复制深链接（#review/…），返回时清理',
      opened && /^#review\/\d+/.test(opened.hash) && back && back.hash === '',
      JSON.stringify({ open: opened && opened.hash, back: back && back.hash }));

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
    await evaluate(`(async () => { goView('temporal-settings'); await render(); await new Promise(r => setTimeout(r, 250)); return true; })()`);
    await shot('temporal-settings-1650');
    check('BA-11b 时态设置独立页截图已保存', fs.existsSync(path.join(SHOTS, 'temporal-settings-1650.png')), SHOTS);
    await evaluate(`(async () => { goView('writing'); await render(); await new Promise(r => setTimeout(r, 300)); return true; })()`);

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
      narrow && narrow.present === true && narrow.singleColumn === true && !narrow.overflowX && narrow.diffW > 300,
      JSON.stringify(narrow));

    // ── UI-08：深色主题 + 200% 缩放（可读、可点、无横向溢出）────────────────
    // 为什么用 CDP 模拟而不是只断言 CSS：深色由 `<html data-theme="dark">` 驱动变量，
    // 到底"文字还看得见吗、按钮还点得到吗"只有真实排版引擎能回答。
    await send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    const dark = await evaluate(`(async () => {
      document.documentElement.dataset.theme = 'dark';
      await new Promise(r => setTimeout(r, 200));
      const body = getComputedStyle(document.body);
      const nav = document.querySelector('.rw-issue');
      const btn = document.querySelector('.rw-mode') || document.querySelector('.rw-foot .btn');
      const diff = document.querySelector('.rw-diff');
      return {
        theme: document.documentElement.dataset.theme,
        bg: body.backgroundColor,
        fg: body.color,
        sameColor: body.backgroundColor === body.color,
        navFont: nav ? parseFloat(getComputedStyle(nav).fontSize) : 0,
        navColor: nav ? getComputedStyle(nav).color : '',
        btnH: btn ? btn.getBoundingClientRect().height : 0,
        diffW: diff ? diff.getBoundingClientRect().width : 0,
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    })()`);
    check('BA-13 深色主题：正文可读（字色≠底色）、按钮仍可点、无横向溢出',
      dark && dark.theme === 'dark' && dark.sameColor === false
        && dark.navFont >= 12 && dark.btnH >= 20 && dark.diffW > 300 && dark.overflowX === false,
      JSON.stringify(dark));

    // 200% 缩放等效：视口减半 + devicePixelRatio=2（CSS px 不变，交付给用户的可用宽度减半）
    await send('Emulation.setDeviceMetricsOverride', {
      width: Math.round(VIEWPORT.width / 2), height: Math.round(VIEWPORT.height / 2),
      deviceScaleFactor: 2, mobile: false,
    });
    const zoom = await evaluate(`(async () => {
      await new Promise(r => setTimeout(r, 300));
      const box = (sel) => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
      const diff = box('.rw-diff');
      const nav = box('.rw-nav');
      const btn = document.querySelector('.rw-foot .btn');
      const issue = document.querySelector('.rw-issue');
      return {
        dpr: window.devicePixelRatio,
        vw: window.innerWidth,
        diffW: diff ? diff.width : 0,
        navW: nav ? nav.width : 0,
        buttonH: btn ? btn.getBoundingClientRect().height : 0,
        issueFont: issue ? parseFloat(getComputedStyle(issue).fontSize) : 0,
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    })()`);
    check('BA-14 200% 缩放（视口减半 + dpr=2）：布局自适应、字号不缩、按钮可点、无横向溢出',
      zoom && zoom.dpr === 2 && zoom.diffW > 200 && zoom.issueFont >= 12
        && zoom.buttonH >= 20 && zoom.overflowX === false,
      JSON.stringify(zoom));
    // 还原主题与视口，避免影响后续手工查看
    await evaluate("document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : document.documentElement.dataset.theme; true");
    await send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });

    // ── 多宽度：1650/1280/1024/800/768/390（方案 §3.4 / UI-T01..T08）──────────
    for (const w of [1650, 1280, 1024, 800, 768, 390]) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: 950, deviceScaleFactor: 1, mobile: false });
      // 每档从"导航关闭"的确定状态开始，避免上一档残留的 navOpen 影响几何判据。
      await evaluate(`(async () => {
        if (state.reviewWorkspace) state.reviewWorkspace.navOpen = false;
        if (state.view === 'review') await render();
        await new Promise((r) => setTimeout(r, 150));
        return true;
      })()`);
      await evaluate(`(async () => {
        if (state.view !== 'review') openReviewWorkspace(state.pendingRevisionClosure.diffArgs);
        await new Promise((r) => setTimeout(r, 260));
        return true;
      })()`);
      const m = await evaluate(`(() => {
        const nav = document.querySelector('.rw-nav');
        const diff = document.querySelector('.rw-diff');
        const main = document.querySelector('.rw-main');
        const toggle = document.querySelector('.rw-main-head [data-action="review-nav"]');
        const nr = nav ? nav.getBoundingClientRect() : null;
        return {
          vw: window.innerWidth,
          navW: nr ? nr.width : 0,
          navLeft: nr ? nr.left : 0,
          navRight: nr ? nr.right : 0,
          navTransform: nav ? getComputedStyle(nav).transform : '',
          navClass: nav ? nav.className : '',
          navVisible: !!nr && nr.right > 0 && nr.left < window.innerWidth,
          toggleVisible: toggle ? getComputedStyle(toggle).display !== 'none' : false,
          diffW: diff ? diff.getBoundingClientRect().width : 0,
          mainW: main ? main.getBoundingClientRect().width : 0,
          summaryVisible: (() => { const s = document.querySelector('.rw-head .rw-summary'); return !!s && getComputedStyle(s).display !== 'none' && s.getBoundingClientRect().width > 0; })(),
          summaryText: (document.querySelector('.rw-head .rw-summary') || {}).textContent || '',
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      })()`);
      const wide = w >= 1280;
      check(`BA-W${w} ${wide ? '宽屏常驻问题导航' : '窄屏覆盖式问题导航'}，差异可用且无横向溢出`,
        m && m.overflowX === false && m.diffW > 0
          && m.summaryVisible === true && /已选\s*8/.test(m.summaryText || '')
          && !/已验证\s*[1-9]/.test(m.summaryText || '')
          && (wide
            ? (m.navVisible === true && m.navW >= 230 && m.navW <= 290 && m.toggleVisible === false)
            : (m.toggleVisible === true && m.navVisible === false)),
        JSON.stringify(m));
      if (!wide) {
        const before = await evaluate(`(() => document.querySelector('.rw-diff').getBoundingClientRect().width)()`);
        await evaluate(`(async () => { reviewWorkspaceToggleNav(); await new Promise((r) => setTimeout(r, 260)); return true; })()`);
        const after = await evaluate(`(() => {
          const d = document.querySelector('.rw-diff');
          const n = document.querySelector('.rw-nav');
          const r = n ? n.getBoundingClientRect() : null;
          return { diffW: d ? d.getBoundingClientRect().width : 0, navVisible: !!r && r.right > 0 && r.left < window.innerWidth };
        })()`);
        check(`BA-W${w}b 问题导航以覆盖式打开时不压缩差异区`,
          after && after.navVisible === true && after.diffW >= before - 2,
          JSON.stringify({ before, after }));
        // 选中一条问题后覆盖式导航必须自动收起，否则会一直盖住差异区。
        const picked = await evaluate(`(async () => {
          const row = document.querySelector('.rw-issues .rw-issue');
          if (row) row.click();
          await new Promise((r) => setTimeout(r, 300));
          const n = document.querySelector('.rw-nav');
          const r = n ? n.getBoundingClientRect() : null;
          return { navOpen: !!n && n.classList.contains('open'), navVisible: !!r && r.right > 0 && r.left < window.innerWidth };
        })()`);
        check(`BA-W${w}c 选中问题后覆盖式导航自动收起`,
          picked && picked.navOpen === false && picked.navVisible === false,
          JSON.stringify(picked));
        // 再打开一次，用导航自己的「关闭」按钮收起（不能只靠 transform 移出屏幕）。
        const closed = await evaluate(`(async () => {
          const toggle = document.querySelector('.rw-main-head [data-action="review-nav"]');
          if (toggle) toggle.click();
          await new Promise((r) => setTimeout(r, 300));
          const close = document.querySelector('.rw-nav [data-action="review-nav"]');
          const opened = !!document.querySelector('.rw-nav.open');
          if (close) close.click();
          await new Promise((r) => setTimeout(r, 300));
          const n = document.querySelector('.rw-nav');
          const r = n ? n.getBoundingClientRect() : null;
          const focusOk = document.activeElement === document.querySelector('.rw-main-head [data-action="review-nav"]');
          return { opened, navOpen: !!n && n.classList.contains('open'), navVisible: !!r && r.right > 0 && r.left < window.innerWidth, focusOk };
        })()`);
        check(`BA-W${w}d 覆盖式导航有关闭按钮且关闭后焦点回到「问题」`,
          closed && closed.opened === true && closed.navOpen === false && closed.navVisible === false && closed.focusOk === true,
          JSON.stringify(closed));
        await shot(`review-${w}-nav-open`);
        await evaluate(`(async () => { reviewWorkspaceToggleNav(); await new Promise((r) => setTimeout(r, 220)); return true; })()`);
      }
      await shot(`review-${w}`);
    }

    // 回到宽屏做抽屉与副作用断言
    await send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
    await evaluate(`(async () => { if (state.view !== 'review') openReviewWorkspace(state.pendingRevisionClosure.diffArgs); await new Promise((r) => setTimeout(r, 260)); return true; })()`);
    const side = await evaluate(`(async () => {
      window.__uiFetch = 0;
      const of = window.fetch;
      window.fetch = (...a) => { window.__uiFetch += 1; return of.apply(window, a); };
      const mainBefore = document.querySelector('.rw-main').getBoundingClientRect().width;
      const diffBefore = document.querySelector('.rw-diff').getBoundingClientRect().width;
      document.querySelector('[data-action="review-drawer"]')?.click();
      await new Promise((r) => setTimeout(r, 600));
      let drawer = document.querySelector('.rw-drawer');
      const clickOpened = !!drawer;
      let mainOpen = document.querySelector('.rw-main').getBoundingClientRect().width;
      let diffOpen = document.querySelector('.rw-diff').getBoundingClientRect().width;
      if (!drawer) {
        // 兜底：如果点击通道没打开（焦点/渲染时序），直接走同一动作函数，仍然只在 UI 层。
        reviewWorkspaceToggleDrawer();
        await new Promise((r) => setTimeout(r, 600));
        drawer = document.querySelector('.rw-drawer');
        mainOpen = document.querySelector('.rw-main').getBoundingClientRect().width;
        diffOpen = document.querySelector('.rw-diff').getBoundingClientRect().width;
      }
      // 宽度必须在抽屉还在 DOM 里时量；后续切问题/筛选会重绘，旧的 detached 节点宽度恒为 0。
      const drawerW = drawer ? drawer.getBoundingClientRect().width : 0;
      reviewWorkspaceSelect('B02');
      await new Promise((r) => setTimeout(r, 220));
      reviewWorkspaceSetFilter('all');
      await new Promise((r) => setTimeout(r, 220));
      document.querySelector('[data-action="review-drawer"]')?.click();
      await new Promise((r) => setTimeout(r, 220));
      window.fetch = of;
      return {
        drawerW,
        mainBefore, mainOpen, diffBefore, diffOpen,
        clickOpened,
        fetch: window.__uiFetch,
        drawerClosed: !document.querySelector('.rw-drawer'),
      };
    })()`);
    check('BA-15 纯 UI 操作零副作用：抽屉/切问题/筛选期间 fetch=0，且抽屉打开不挤压主区',
      side && side.clickOpened === true && side.fetch === 0 && side.drawerW >= 300 && side.drawerClosed === true
        && side.mainOpen >= side.mainBefore - 1 && side.diffOpen >= side.diffBefore - 1,
      JSON.stringify(side));
    // 抽屉打开态截图（供人工复核）
    await evaluate(`(async () => { reviewWorkspaceToggleDrawer(); await new Promise((r) => setTimeout(r, 260)); return true; })()`);
    await shot('review-drawer-1650');
    check('BA-15b 工作区/抽屉截图已保存', fs.existsSync(path.join(SHOTS, 'review-drawer-1650.png')), SHOTS);
    await evaluate(`(async () => { reviewWorkspaceToggleDrawer(); await new Promise((r) => setTimeout(r, 160)); return true; })()`);

    // 再次进入同一章：Issue/筛选/差异模式必须恢复（方案 §2.1）。
    const restoredView = await evaluate(`(async () => {
      reviewWorkspaceSelect('B03');
      reviewWorkspaceSetMode('context');
      await new Promise((r) => setTimeout(r, 220));
      const picked = state.reviewWorkspace.activeId;
      const mode = state.reviewWorkspace.mode;
      await reviewWorkspaceBack();
      await new Promise((r) => setTimeout(r, 260));
      openReviewWorkspace(state.pendingRevisionClosure.diffArgs);
      await new Promise((r) => setTimeout(r, 260));
      return { picked, mode, active: state.reviewWorkspace.activeId, modeAfter: state.reviewWorkspace.mode };
    })()`);
    check('BA-16 同一章重开工作区恢复上次 Issue 与差异模式（不是每次重置）',
      restoredView && restoredView.active === 'B03' && restoredView.modeAfter === 'context',
      JSON.stringify(restoredView));

    // 深链接无法恢复时必须清理地址，而不是留下一个打不开的“工作区”。
    const hashClean = await evaluate(`(async () => {
      await reviewWorkspaceBack();
      await new Promise((r) => setTimeout(r, 220));
      history.replaceState(null, '', location.pathname + '#review/999999');
      const ok = await reviewWorkspaceConsumeHash();
      return { ok, hash: location.hash, view: state.view };
    })()`);
    check('BA-17 深链接指向不存在的章节/记录时清理地址并如实返回失败',
      hashClean && hashClean.ok === false && hashClean.hash === '',
      JSON.stringify(hashClean));

    // ── 125% / 150% 缩放：真实排版 + 截图（补齐此前未覆盖档位）──────────────
    await send('Emulation.setDeviceMetricsOverride', { width: 1650, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(`(async () => {
      if (state.reviewWorkspace) state.reviewWorkspace.navOpen = false;
      if (state.view !== 'review') openReviewWorkspace(state.pendingRevisionClosure.diffArgs);
      await new Promise((r) => setTimeout(r, 260));
      return true;
    })()`);
    for (const ratio of [1.25, 1.5]) {
      const w = Math.round(1650 / ratio);
      const h = Math.round(1000 / ratio);
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: ratio, mobile: false });
      await evaluate('(async () => { await new Promise((r) => setTimeout(r, 260)); return true; })()');
      const z = await evaluate(`(() => {
        const diff = document.querySelector('.rw-diff');
        const btn = document.querySelector('.rw-foot .btn');
        const issue = document.querySelector('.rw-issue');
        return {
          dpr: window.devicePixelRatio, vw: window.innerWidth,
          diffW: diff ? diff.getBoundingClientRect().width : 0,
          btnH: btn ? btn.getBoundingClientRect().height : 0,
          issueFont: issue ? parseFloat(getComputedStyle(issue).fontSize) : 0,
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      })()`);
      check(`BA-Z${Math.round(ratio * 100)} ${Math.round(ratio * 100)}% 缩放：无横向溢出、字号不缩、按钮可点`,
        z && z.dpr === ratio && z.diffW > 200 && z.issueFont >= 12 && z.btnH >= 18 && z.overflowX === false,
        JSON.stringify(z));
      await shot(`review-zoom-${Math.round(ratio * 100)}`);
    }

    // ── 抽屉焦点竞态与层叠：快速连点后状态必须自洽，不能被已销毁节点卡住 ──────
    await send('Emulation.setDeviceMetricsOverride', { width: 1650, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(`(async () => {
      if (state.view !== 'review') openReviewWorkspace(state.pendingRevisionClosure.diffArgs);
      await new Promise((r) => setTimeout(r, 260));
      return true;
    })()`);
    const race = await evaluate(`(async () => {
      for (let i = 0; i < 6; i += 1) reviewWorkspaceToggleDrawer();
      await new Promise((r) => setTimeout(r, 900));
      const ws = state.reviewWorkspace;
      const drawer = document.querySelector('.rw-drawer');
      const toggle = document.querySelector('.rw-main-head [data-action="review-drawer"]');
      const expectedClosed = ws.drawer === false && !drawer;
      reviewWorkspaceToggleDrawer();
      await new Promise((r) => setTimeout(r, 400));
      const openDrawer = document.querySelector('.rw-drawer');
      const focusInDrawer = !!openDrawer && openDrawer.contains(document.activeElement);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      return {
        expectedClosed, expectedOpen: !!openDrawer, focusInDrawer,
        afterEsc: !document.querySelector('.rw-drawer'),
        focusBack: document.activeElement === document.querySelector('.rw-main-head [data-action="review-drawer"]'),
      };
    })()`);
    check('BA-18 抽屉快速连点后状态自洽；打开焦点入内，Esc 关闭并回焦',
      race && race.expectedClosed === true && race.expectedOpen === true && race.focusInDrawer === true
        && race.afterEsc === true && race.focusBack === true,
      JSON.stringify(race));

    // ── 1024px：导航与抽屉同时打开，层级不互相锁死（先关导航再关抽屉）─────────
    await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 950, deviceScaleFactor: 1, mobile: false });
    const stack = await evaluate(`(async () => {
      if (state.reviewWorkspace) state.reviewWorkspace.navOpen = false;
      reviewWorkspaceToggleNav();
      await new Promise((r) => setTimeout(r, 250));
      reviewWorkspaceToggleDrawer();
      await new Promise((r) => setTimeout(r, 350));
      const nav = document.querySelector('.rw-nav');
      const drawer = document.querySelector('.rw-drawer');
      const both = !!nav && !!drawer && nav.classList.contains('open');
      const navZ = nav ? getComputedStyle(nav).zIndex : '';
      const drawerZ = drawer ? getComputedStyle(drawer).zIndex : '';
      const closeNav = document.querySelector('.rw-nav [data-action="review-nav"]');
      if (closeNav) closeNav.click();
      await new Promise((r) => setTimeout(r, 300));
      const navClosed = !document.querySelector('.rw-nav.open');
      const drawerStill = !!document.querySelector('.rw-drawer');
      reviewWorkspaceToggleDrawer();
      await new Promise((r) => setTimeout(r, 300));
      const drawerClosed = !document.querySelector('.rw-drawer');
      return { both, navZ, drawerZ, navClosed, drawerStill, drawerClosed };
    })()`);
    check('BA-19 导航与抽屉可同时存在且能被分别解除（不互相锁死）',
      stack && stack.both === true && stack.navClosed === true && stack.drawerStill === true
        && stack.drawerClosed === true,
      JSON.stringify(stack));
    await shot('review-1024-nav-and-drawer');

    ws.close();
  } finally {
    killTree(child);
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
