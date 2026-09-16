#!/usr/bin/env node
/**
 * cutover.mjs —— P6 一次性切换的受控执行器（预检 / 彩排 / 执行 / 回滚）。
 *
 * 为什么要有它：P6 的动作只有一行（`harness.js` 的默认 dsh profile 从 headless 翻到 novel），
 * 但围绕它的**手工分步流程**才是风险所在。本会话已经吃过一次同类亏：
 * 「先起实例、再设变量、再跑测试」这种手工编排错配了实例，产生了未经批准的真实调用。
 * 所以 P6 也按同一套纪律工具化：**预检 → 彩排 → 显式确认 → 执行 → 可回滚**，
 * 每一步都有机器可核对的判据。
 *
 * 四个模式：
 *   --check     只读预检：列出**将要改动的每一处**、给出确认令牌、报出前置问题
 *   --rehearse  全流程彩排：全部文件 I/O 都在副本上做，最后断言**真实产物哈希未变**
 *   --execute   真实执行：先备份（S1）再翻转默认值（S3）；需 --confirm=<令牌>
 *   --rollback  从备份还原并按 manifest 校验哈希
 *
 * 它**不做**的三件事（刻意留给操作者，避免脚本越权）：
 *   1. 不停止/重启主实例（S2/S4 的进程动作由你执行）；
 *   2. 不发起任何真实写作冒烟（会产生 API 费用，需单独许可）；
 *   3. 不复制 profile 的 node_modules（内含 junction，递归复制有跟随目标的风险；
 *      该目录可由 install-profile.mjs 重装，可复现，无需备份）。
 *
 * 用法:
 *   node .p6-cutover/cutover.mjs --check
 *   node .p6-cutover/cutover.mjs --rehearse
 *   node .p6-cutover/cutover.mjs --execute --confirm=P6-CUTOVER-xxxxxxxx
 *   node .p6-cutover/cutover.mjs --rollback data/backup-p6-<stamp>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

export const HARNESS_JS = path.join(REPO, 'harness.js');

/**
 * 要翻转的源码锚点。用**带上下文的精确串**而不是宽泛正则：
 * 源码一变动，替换数就不等于 1，脚本会**失败而不是静默无效**——
 * 这正是「校验器必须能从被校验对象派生」的同一条纪律。
 */
export const EDITS = [
  {
    name: '默认 profile（无环境变量时）',
    from: "  if (!raw) return 'headless';",
    to: "  if (!raw) return 'novel';",
  },
  {
    name: '非法值的兜底 profile',
    from: "      message: 'NOVELSTUDIO_DSH_PROFILE 非法（仅允许字母/数字/点/下划线/连字符），已回退 headless',",
    to: "      message: 'NOVELSTUDIO_DSH_PROFILE 非法（仅允许字母/数字/点/下划线/连字符），已回退 novel',",
  },
  {
    name: '非法值的兜底返回值',
    from: "    return 'headless';\n  }\n  return raw;",
    to: "    return 'novel';\n  }\n  return raw;",
  },
  {
    name: '顶部文件注释',
    from: '// profile 名由 DSH_PROFILE 决定（环境变量 NOVELSTUDIO_DSH_PROFILE，默认 headless）。',
    to: '// profile 名由 DSH_PROFILE 决定（环境变量 NOVELSTUDIO_DSH_PROFILE，默认 novel）。',
  },
  {
    name: '切换说明注释（记录已切换与回滚方式）',
    from: `// 默认值刻意**仍是 headless**：P0..P5 全程隔离开发，线上行为不变；切换是 P6 的
// 一次性动作。要让隔离实例或试运行使用专用 profile，设 NOVELSTUDIO_DSH_PROFILE=novel。`,
    to: `// 【P6 已切换】默认值 = novel（2026-09-15 一次性切换，证据见 docs/p6-cutover-runbook.md）。
// 回滚：把下面两处 'novel' 改回 'headless'，或跑
//   node .p6-cutover/cutover.mjs --rollback data/backup-p6-<stamp>
// 临时试运行其它 profile：设 NOVELSTUDIO_DSH_PROFILE=<名字>（不影响默认值）。`,
  },
];

/** 确认令牌由**实际改动内容**派生：不看清单就拿不到令牌。 */
export function confirmToken(edits = EDITS) {
  const h = crypto.createHash('sha256');
  for (const e of edits) h.update(e.name).update('\0').update(e.from).update('\0').update(e.to);
  return 'P6-CUTOVER-' + h.digest('hex').slice(0, 8);
}

export function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** 把锚点里用 `\n` 写的多行串适配到目标文件的实际行尾（本仓库是 CRLF）。 */
export function adaptEol(s, eol) {
  return eol === '\r\n' ? s.replace(/\n/g, '\r\n') : s;
}

/** 把 EDITS 应用到一段源码文本；每处替换数必须正好是 1。 */
export function applyEdits(src, edits = EDITS) {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  let out = src;
  const applied = [];
  for (const e of edits) {
    const from = adaptEol(e.from, eol);
    const to = adaptEol(e.to, eol);
    const n = out.split(from).length - 1;
    if (n !== 1) {
      return { ok: false, applied, failed: { name: e.name, found: n } };
    }
    out = out.replace(from, to);
    applied.push(e.name);
  }
  return { ok: true, applied, text: out };
}

/** 判断当前源码处于哪种状态。 */
export function detectState(src) {
  const hasOld = src.includes("if (!raw) return 'headless';");
  const hasNew = src.includes("if (!raw) return 'novel';");
  if (hasOld && !hasNew) return 'pre-cutover';
  if (hasNew && !hasOld) return 'post-cutover';
  if (hasOld && hasNew) return 'mixed';
  return 'unknown';
}

function sha256Text(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function freePortProbe(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const done = (v) => { try { s.destroy(); } catch { /* 忽略 */ } resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

/** 读 dsh profile 的骨架信息（不递归进 node_modules）。 */
function inspectProfile(name) {
  const dir = path.join(DSH_HOME, 'profiles', name);
  const info = { name, dir, exists: fs.existsSync(dir) };
  if (!info.exists) return info;

  // 是否 bundle 制：bundle 制 profile 的注入与瘦身都下沉在 bundle 层，
  // 自己的 cordis.patch.yml **就该是 `[]`**（留给用户自定义）。
  const pkgPath = path.join(dir, 'package.json');
  info.pkg = fs.existsSync(pkgPath) ? pkgPath : null;
  if (info.pkg) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      info.bundles = pkg?.dsh?.profile?.bundles || [];
    } catch { info.bundles = null; }
  }

  const patch = path.join(dir, 'cordis.patch.yml');
  info.patch = fs.existsSync(patch) ? patch : null;
  if (info.patch) {
    const text = fs.readFileSync(info.patch, 'utf8');
    // dsh 的硬要求：去掉注释后必须是**合法顶层 YAML 数组**。
    // 彩排抓过的坑：移除唯一条目后只剩注释 → 不是数组 → dsh 启动直接失败。
    const stripped = text.split(/\r?\n/).filter((l) => !l.trim().startsWith('#')).join('\n').trim();
    info.patchStripped = stripped;
    info.patchValidArray = stripped.startsWith('[') || /^-\s/m.test(stripped);
    info.patchIsEmptyArray = stripped === '[]';
    info.patchHasEntries = /^-\s/m.test(stripped);
  }

  const nm = path.join(dir, 'node_modules');
  if (fs.existsSync(nm)) {
    try { info.nodeModulesIsLink = fs.lstatSync(nm).isSymbolicLink(); } catch { info.nodeModulesIsLink = null; }
    const nt = path.join(nm, 'novel-writing');
    if (fs.existsSync(nt)) {
      try { info.novelWritingIsLink = fs.lstatSync(nt).isSymbolicLink(); } catch { info.novelWritingIsLink = null; }
      try { info.novelWritingTarget = fs.realpathSync(nt); } catch { /* 忽略 */ }
    }
  }
  return info;
}

/** 需要备份的**文本**产物（不含 profile 的 node_modules，理由见文件头）。 */
export function backupPlan(profile = 'novel') {
  const items = [
    { rel: 'data/novel.db', src: path.join(REPO, 'data', 'novel.db'), required: true },
    { rel: 'data/novel.db-wal', src: path.join(REPO, 'data', 'novel.db-wal'), required: false },
    { rel: 'data/novel.db-shm', src: path.join(REPO, 'data', 'novel.db-shm'), required: false },
    { rel: 'harness.js', src: HARNESS_JS, required: true },
    { rel: 'dsh/settings.yaml', src: path.join(DSH_HOME, 'settings.yaml'), required: false },
    { rel: `dsh/profiles/${profile}/cordis.patch.yml`, src: path.join(DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), required: false },
    { rel: `dsh/profiles/${profile}/package.json`, src: path.join(DSH_HOME, 'profiles', profile, 'package.json'), required: false },
    { rel: 'dsh/profiles/headless/cordis.patch.yml', src: path.join(DSH_HOME, 'profiles', 'headless', 'cordis.patch.yml'), required: false },
  ];
  return items;
}

function doBackup(dir, profile = 'novel') {
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const it of backupPlan(profile)) {
    if (!fs.existsSync(it.src)) {
      if (it.required) throw new Error(`必备份项缺失：${it.src}`);
      files.push({ rel: it.rel, missing: true });
      continue;
    }
    const dst = path.join(dir, it.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(it.src, dst);
    const a = sha256File(it.src), b = sha256File(dst);
    if (a !== b) throw new Error(`备份校验失败（哈希不一致）：${it.rel}`);
    files.push({ rel: it.rel, sha256: a, size: fs.statSync(dst).size });
  }
  const manifest = {
    stamp: path.basename(dir),
    createdAt: new Date().toISOString(),
    gitHead: (() => { try { return fs.readFileSync(path.join(REPO, '.git', 'HEAD'), 'utf8').trim(); } catch { return ''; } })(),
    files,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

// ── 模式实现 ───────────────────────────────────────────────────────────────
async function check() {
  const src = fs.readFileSync(HARNESS_JS, 'utf8');
  const state = detectState(src);
  const plan = applyEdits(src);
  let bad = 0;
  const say = (ok, text) => { if (!ok) bad++; console.log(`  ${ok ? '✓' : '✗'} ${text}`); };

  console.log('═══ P6 预检（只读）═══\n');
  console.log(`harness.js 当前状态：${state}`);
  if (state === 'post-cutover') {
    console.log('  已经是 novel —— 无需切换（若要回滚见 --rollback）。');
    return;
  }
  say(plan.ok, plan.ok
    ? `改动锚点全部命中（${plan.applied.length} 处，各 1 次）`
    : `锚点 ` + `「${plan.failed.name}」命中 ${plan.failed.found} 次（期望 1）—— 源码变了，先修脚本再切`);

  console.log('\n将要改动的每一处：');
  for (const e of EDITS) console.log(`  · ${e.name}`);
  console.log(`\n确认令牌：${confirmToken()}`);
  const printedOk = selfCheckPrintedCommand(confirmToken());
  say(printedOk, printedOk
    ? '自检：下面打印的执行命令能被本工具的解析器读懂（照抄即可用）'
    : '自检失败：打印的命令解析不出来 —— 先修 arg() 再让人照抄');
  console.log(`执行命令：node .p6-cutover/cutover.mjs --execute --confirm=${confirmToken()}`);

  console.log('\n前置状态：');
  const novel = inspectProfile('novel');
  say(novel.exists, `profile novel 存在（${novel.dir}）`);
  if (novel.exists) {
    const bundleBased = (novel.bundles || []).length > 0;
    say(Boolean(novel.patch), 'profile novel 有 cordis.patch.yml');
    say(novel.patchValidArray === true,
      'patch 去掉注释后是合法顶层数组'
      + (novel.patchIsEmptyArray ? '（`[]`）' : ''));
    // bundle 制 profile 的注入下沉在 bundle 层，此文件为 `[]` 是**设计如此**；
    // 非 bundle 制才要求它自身带条目。（第一版把「必须有条目」写成硬条件 → 假警报。）
    if (bundleBased) {
      say(novel.patchHasEntries === false || novel.patchHasEntries === true,
        `bundle 制 profile（bundles: ${novel.bundles.join(', ')}）→ patch 为 `
        + (novel.patchIsEmptyArray ? '`[]` 属设计如此' : '自定义条目，正常'));
    } else {
      say(novel.patchHasEntries === true, '非 bundle 制：patch 必须自带条目（否则等于没注入）');
    }
    say(novel.novelWritingIsLink !== false, 'novel-writing 已接线'
      + (novel.novelWritingTarget ? ` → ${novel.novelWritingTarget}` : ''));
  }
  const headless = inspectProfile('headless');
  say(headless.exists, 'profile headless 存在（回滚目标）');

  const db = path.join(REPO, 'data', 'novel.db');
  say(fs.existsSync(db), `主库存在（${path.relative(REPO, db)}）`);
  const wal = path.join(REPO, 'data', 'novel.db-wal');
  if (fs.existsSync(wal)) {
    console.log(`  ⚠ 存在 ${path.relative(REPO, wal)}（${(fs.statSync(wal).size / 1024).toFixed(0)}KB）`
      + ' —— 备份必须连它一起，否则丢数据');
  }

  const running = await freePortProbe(3737);
  console.log(`  ${running ? '⚠' : '✓'} 主实例 3737 ${running ? '正在运行 —— 执行前请先停（S2）' : '未运行'}`);

  const bkRoot = path.join(REPO, 'data');
  try { fs.accessSync(bkRoot, fs.constants.W_OK); say(true, '备份根目录可写（data/）'); }
  catch { say(false, '备份根目录不可写（data/）'); }

  console.log(`\n${bad ? `✗ 预检发现 ${bad} 处问题，先处理再切。` : '✓ 预检通过。'}`);
  process.exitCode = bad ? 1 : 0;
}

function rehearse() {
  // 14 位时间戳：早先 slice(0,15) 会把毫秒前的那个点也带进来，
  // 目录名以 `.` 结尾在 Windows 上会被 Win32 API 悄悄剥掉。
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const root = path.join(HERE, '.rehearsal', stamp);
  const bk = path.join(root, 'backup');
  console.log(`═══ P6 彩排（全部在副本上做，真实产物只读）═══\n临时目录：${path.relative(REPO, root)}\n`);

  // 彩排前后都要比对真实产物哈希：这是「彩排没有副作用」的判据。
  const watch = [HARNESS_JS, path.join(REPO, 'data', 'novel.db')]
    .filter((p) => fs.existsSync(p));
  const before = Object.fromEntries(watch.map((p) => [p, sha256File(p)]));

  let bad = 0;
  const say = (ok, text) => { if (!ok) bad++; console.log(`  ${ok ? '✓' : '✗'} ${text}`); };
  fs.mkdirSync(root, { recursive: true });

  // ⚠️ 整段流程放在 try/finally 里：第 5 步「真实产物未被改动」是**安全网**，
  // 必须在中途异常时也执行。阴性对照抓到过：变异后流程崩在断言之前（ENOENT），
  // 于是安全网根本没跑，真实文件被翻转却报不出问题。
  try {
    // 1) 备份（真实读、副本写）
    const manifest = doBackup(bk);
    say(manifest.files.some((f) => f.rel === 'harness.js' && f.sha256),
      `备份 harness.js 并逐文件校验哈希（共 ${manifest.files.filter((f) => f.sha256).length} 项）`);
    const dbItems = manifest.files.filter((f) => f.sha256 && f.rel.startsWith('data/novel.db'));
    say(dbItems.length >= 1, `备份数据库三件套中存在的部分（${dbItems.map((f) => f.rel.replace('data/', '')).join(', ')}）`);
    if (fs.existsSync(path.join(REPO, 'data', 'novel.db-wal'))) {
      say(dbItems.some((f) => f.rel.endsWith('-wal')), 'WAL 已一并备份（只复制 novel.db 会丢数据）');
    }

    // 2) 翻转：只动副本
    const copyPath = path.join(root, 'harness.js.copy');
    const src = fs.readFileSync(HARNESS_JS, 'utf8');
    const plan = applyEdits(src);
    say(plan.ok, plan.ok ? `副本上应用 ${plan.applied.length} 处改动，各命中 1 次` : `锚点未命中：${plan.failed?.name}`);
    if (plan.ok) {
      fs.writeFileSync(copyPath, plan.text);
      const after = fs.readFileSync(copyPath, 'utf8');
      say(detectState(after) === 'post-cutover', '副本已成为 post-cutover');
      say(after !== src, '副本内容确实与真实文件不同（不是空操作）');

      // 3) 回滚：从备份还原副本，断言逐字节一致
      const restored = path.join(root, 'harness.js.restored');
      fs.copyFileSync(path.join(bk, 'harness.js'), restored);
      say(sha256File(restored) === sha256Text(src), '从备份还原后与真实文件逐字节一致');

      // 4) 幂等与负向：把已完成态再跑一次必须拒绝
      const again = applyEdits(plan.text);
      say(again.ok === false, '对已完成态再跑一次会被拒绝（不静默重复改）');
    }
  } catch (e) {
    bad++;
    console.log(`  ✗ 彩排中途异常：${e.message}`);
  } finally {
    // 5) 安全网：真实产物哈希必须未变（异常路径也要跑）
    for (const [p, h] of Object.entries(before)) {
      say(fs.existsSync(p) && sha256File(p) === h, `真实产物未被彩排改动：${path.relative(REPO, p)}`);
    }
    console.log(`\n${bad ? `✗ 彩排发现 ${bad} 处问题。` : '✓ 彩排通过：流程可用，且真实产物零改动。'}`);
    console.log(bad ? '' : '（下次真实执行时脚本会另建 data/backup-p6-<stamp>/，不是这个临时目录）');
    process.exitCode = bad ? 1 : 0;
  }
}

function execute(confirm) {
  const src = fs.readFileSync(HARNESS_JS, 'utf8');
  const state = detectState(src);
  if (state === 'post-cutover') { console.log('已是 post-cutover，无需执行。'); return; }
  const want = confirmToken();
  if (confirm !== want) {
    console.error(`确认令牌不符。\n  需要：--confirm=${want}\n  实收：--confirm=${confirm || '(空)'}\n`
      + '令牌由实际改动内容派生；请先跑 --check 阅读将要改动的每一处。');
    process.exit(2);
  }
  const plan = applyEdits(src);
  if (!plan.ok) {
    console.error(`锚点「${plan.failed.name}」命中 ${plan.failed.found} 次（期望 1）—— 源码变了，拒绝执行。`);
    process.exit(1);
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bk = path.join(REPO, 'data', `backup-p6-${stamp}`);
  const manifest = doBackup(bk);
  console.log(`✓ S1 备份完成：${path.relative(REPO, bk)}（${manifest.files.filter((f) => f.sha256).length} 项，含 manifest.json）`);
  fs.writeFileSync(HARNESS_JS, plan.text);
  if (sha256File(HARNESS_JS) !== sha256Text(plan.text)) {
    console.error('✗ 写入校验失败，正在还原…');
    fs.copyFileSync(path.join(bk, 'harness.js'), HARNESS_JS);
    process.exit(1);
  }
  console.log(`✓ S3 完成：默认 dsh profile 已翻转为 novel（改动 ${plan.applied.length} 处）`);
  console.log(`\n接下来（脚本刻意不做）：`);
  console.log(`  S2/S4  重启主实例（若之前在运行）`);
  console.log(`  验证   node .p0-recon/verify-harness-profile.mjs novel   ← 自设死端口，零计费`);
  console.log(`         node .p1-baseline/verify-plugin-tools.mjs`);
  console.log(`         node .p1-baseline/verify-ai-branches.mjs`);
  console.log(`         node .p1-baseline/survey.mjs data/novel.db`);
  console.log(`  冒烟   一次真实写作（会产生 API 费用，需单独许可）`);
  console.log(`  回滚   node .p6-cutover/cutover.mjs --rollback ${path.relative(REPO, bk)}`);
}

function rollback(dir) {
  if (!dir) { console.error('用法: --rollback <备份目录>'); process.exit(2); }
  const abs = path.resolve(REPO, dir);
  const mf = path.join(abs, 'manifest.json');
  if (!fs.existsSync(mf)) { console.error(`找不到 ${mf}`); process.exit(2); }
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  console.log(`═══ 从 ${path.relative(REPO, abs)} 回滚 ═══（备份时间 ${manifest.createdAt}）\n`);
  let bad = 0;
  for (const f of manifest.files) {
    if (!f.sha256) continue;
    const src = path.join(abs, f.rel);
    if (sha256File(src) !== f.sha256) { console.log(`  ✗ 备份自身已损坏：${f.rel}`); bad++; continue; }
    const target = f.rel === 'harness.js' ? HARNESS_JS : null; // 仅代码文件自动还原
    if (target) {
      fs.copyFileSync(src, target);
      const ok = sha256File(target) === f.sha256;
      if (!ok) bad++;
      console.log(`  ${ok ? '✓' : '✗'} 已还原 ${f.rel}`);
    } else {
      console.log(`  – ${f.rel}：备份完好（数据库/profile 请按需求手工还原，脚本不擅自动你的数据）`);
    }
  }
  console.log(bad ? `\n✗ 回滚有 ${bad} 处问题。` : '\n✓ 代码侧已还原。重启主实例即回到切换前。');
  process.exitCode = bad ? 1 : 0;
}

// ── CLI ────────────────────────────────────────────────────────────────────
/**
 * 同时接受 `--name value` 与 `--name=value` 两种写法。
 *
 * ⚠️ 早先只支持前者，而 `--check` 打印给用户的命令是 `--execute --confirm=<令牌>`——
 * **照着自己打印的命令跑会直接失败**（实测：`实收：--confirm=(空)`）。
 * 工具打印的指令必须能被自己的解析器读懂，否则等于在骗使用者。
 */
export const arg = (n, d) => {
  const pref = `${n}=`;
  const eq = process.argv.find((a) => a.startsWith(pref));
  if (eq) return eq.slice(pref.length);
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

/** 自检：把「将要打印的命令」喂回自己的解析器，确认拿得到同一个值。 */
export function selfCheckPrintedCommand(token) {
  const printed = `--execute --confirm=${token}`;
  const saved = process.argv;
  try {
    process.argv = ['node', 'cutover.mjs', ...printed.split(' ')];
    return arg('--confirm', '') === token;
  } finally {
    process.argv = saved;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  if (process.argv.includes('--rehearse')) rehearse();
  else if (process.argv.includes('--execute')) execute(arg('--confirm', ''));
  else if (process.argv.includes('--rollback')) rollback(arg('--rollback', ''));
  else await check();
}
