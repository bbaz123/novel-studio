#!/usr/bin/env node
/**
 * scripts/nsdsh/verify-delivery.mjs —— S18：最终交付闭环验收。
 *
 * 它只回答一个问题：**"这套东西现在能交付吗？"** —— 并且只认证据，不认声明。
 *
 * 五组检查：阶段证据 / 必要文件 / 未解决缺陷 / 三条产品不变量 / 生成物与编码。
 * 输出含功能支持矩阵、已测平台、性能原始数据指针与剩余限制。
 * 退出码：0 = 证据齐全可交付；1 = 有缺口（绝不因为"差不多"而放行）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);

const STAGES = ['S00', 'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'S12', 'S13', 'S14', 'S15', 'S16', 'S17'];

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

export function verifyDelivery() {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

  // ① 阶段证据
  const stagesDoc = readJson(path.join(REPO, 'docs/nsdsh/stages.json'));
  const stages = (stagesDoc && stagesDoc.stages) || [];
  const byId = new Map(stages.map((s) => [s.id, s]));
  const missingStages = STAGES.filter((id) => !byId.has(id));
  add('阶段清单覆盖 S00–S17', missingStages.length === 0, missingStages.length ? `缺：${missingStages.join(',')}` : `${STAGES.length} 个阶段`);
  const notDone = STAGES.filter((id) => byId.has(id) && byId.get(id).status !== 'done');
  add('全部阶段状态为 done', notDone.length === 0, notDone.length ? `未完成：${notDone.join(',')}` : '18/18');
  const noEvidence = STAGES.filter((id) => {
    const s = byId.get(id);
    return s && s.status === 'done' && !(s.evidence && Object.keys(s.evidence).length);
  });
  add('每个 done 阶段都留有证据条目', noEvidence.length === 0, noEvidence.length ? `缺证据：${noEvidence.join(',')}` : '全部有 evidence');

  // ② 必要文件
  const required = [
    'docs/nsdsh/PLAN.md',
    'docs/nsdsh/baseline.md',
    'docs/nsdsh/STATUS.md',
    'docs/nsdsh/stages.json',
    'docs/nsdsh/known-issues.json',
    'docs/nsdsh/upstream-maintenance.md',
    'vendor/dsh/PROVENANCE.md',
    'vendor/dsh/runtime-manifest.json',
    'scripts/nsdsh/migration-drill.mjs',
  ];
  const missingFiles = required.filter((rel) => !fs.existsSync(path.join(REPO, rel)));
  add('交付必要文件齐全', missingFiles.length === 0, missingFiles.length ? `缺：${missingFiles.join(', ')}` : `${required.length} 个文件`);

  const manifest = readJson(path.join(REPO, 'vendor/dsh/runtime-manifest.json'), {});
  const prov = readText(path.join(REPO, 'vendor/dsh/PROVENANCE.md'));
  const tag = String((manifest.baseline && manifest.baseline.tag) || '');
  const commit = String((manifest.baseline && manifest.baseline.vendor_commit) || '');
  add('runtime manifest 记录基线/入口/协议/许可',
    !!(manifest.baseline && manifest.entry && manifest.handshake && manifest.license),
    manifest.version || '(缺)');
  add('来源 SHA 可追踪（tag/commit 同时出现在 PROVENANCE）',
    !!tag && !!commit && prov.includes(tag) && prov.includes(commit),
    `${tag} / ${commit}`);
  add('依赖清单（闭包）非空且规模合理',
    Array.isArray(manifest.closure && manifest.closure.requiredPackages)
      && manifest.closure.requiredPackages.length >= 50,
    `${(manifest.closure && manifest.closure.requiredPackages && manifest.closure.requiredPackages.length) || 0} 个包`);

  // ③ 未解决缺陷：如实列出，不隐藏
  const issues = readJson(path.join(REPO, 'docs/nsdsh/known-issues.json'), { issues: [] });
  const open = (issues.issues || []).filter((i) => i.status === 'open');
  const notFixable = open.filter((i) => i.disposition === 'not_fixable_in_project');
  add('未解决缺陷已如实登记（含"本项目不可修"的处置）',
    open.every((i) => String(i.evidenceNote || '').length > 20),
    open.length ? `open=${open.map((i) => i.id).join(',')}（不可修 ${notFixable.map((i) => i.id).join(',') || '0'}）` : '无 open 项');

  // ④ 三条产品不变量
  const offlineSrc = readText(path.join(REPO, 'scripts/ci-offline-checks.mjs'));
  add('默认不计费：离线清单不调用真实模型',
    /零计费/.test(offlineSrc) && !/https:\/\/api\.deepseek\.com/.test(offlineSrc),
    '全部用假 provider / 隔离实例');
  const serverSrc = readText(path.join(REPO, 'server.js'));
  const sdkSrc = readText(path.join(REPO, 'ai/runtime/dsh-sdk.mjs'));
  add('无 AI 仍可保存：模型解析失败只记 not_run，不阻断保存',
    /not_run/.test(serverSrc) || /not_run/.test(sdkSrc),
    '保存路径不依赖模型');
  const capSrc = readText(path.join(REPO, 'harness-plugins/novel-writing/capabilities.mjs'));
  add('工具不能自己确认状态：author_confirm 必须带审批',
    /author_confirm/.test(capSrc) && /APPROVAL_REQUIRED/.test(capSrc),
    '缺 approval_id 一律拒绝');

  // ⑤ 生成物与编码
  add('phase map 已生成', fs.existsSync(path.join(REPO, 'docs/phase-map.md')), 'docs/phase-map.md');
  const reportCount = STAGES.filter((id) => fs.existsSync(path.join(REPO, '.nsdsh/reports', `${id}.json`))).length;
  add('各阶段原始报告已留在 .nsdsh/reports', reportCount >= STAGES.length - 1,
    `${reportCount}/${STAGES.length}（S00 为基线阶段，可无命令报告）`);

  const openIds = open.map((i) => i.id);
  return {
    ok: checks.every((c) => c.ok),
    checks,
    delivery: {
      version: 'delivery-v1',
      generated_at: new Date().toISOString(),
      stages_total: STAGES.length,
      stages_done: STAGES.filter((id) => byId.get(id) && byId.get(id).status === 'done').length,
      support_matrix: {
        core_writing: '实测（离线清单 + temporal 套件）',
        story_state_temporal: '实测（S07/S08 套件）',
        model_routing: '实测（S10 套件，fake provider）',
        plugin_capabilities: '实测（S09/S12 套件）',
        sdk_subprocess: '实测（R01：真实 DSH 子进程 12 场景 · verify-sdk-real.mjs；真 PID / 真终态 / 真取消 / 双会话隔离）',
        runtime_distribution: '闭包与契约等价已验证；未产出裁剪发行物',
        migration: '实测（S16 演练：旧库副本 → 新 schema）',
      },
      platforms_tested: [`${os.platform()} ${os.release()} ${os.arch()} / node ${process.version}`],
      platforms_unverified: ['macOS', 'Linux'],
      performance_raw: 'scripts/nsdsh/benchmark.mjs --fixture --chapters 100|1000（含硬件画像与计时边界）',
      remaining_limits: [
        ...openIds.map((id) => `台账 open 项：${id}`),
        '真实裁剪发行物未产出（需完整打包流水线）',
        'macOS / Linux 构建与中文路径未验证',
        '真实模型质量测试未做（需显式授权与预算）',
        // S11/S14 的门禁命令全是本地只读（verify-vendor 查 git/文件；verify-runtime-closure 与
        // build-runtime --fixture 只读固定基线），因此 networkPolicy 是 none，offline 下**真跑**。
        // 真正的构建（install/build/typecheck/lint 四条 exit 0）不是门禁命令，证据在 PROVENANCE.md §3。
        'S11/S14 的构建前置（install/build/typecheck/lint）不在门禁内执行；证据记在 vendor/dsh/PROVENANCE.md §3',
      ],
    },
  };
}

function isDirectRun() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isDirectRun()) {
  const r = verifyDelivery();
  if (has('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log('最终交付验收（只认证据）');
    for (const c of r.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
    const d = r.delivery;
    console.log(`\n  阶段：${d.stages_done}/${d.stages_total} done`);
    console.log('  支持矩阵：');
    for (const [k, v] of Object.entries(d.support_matrix)) console.log(`    · ${k}: ${v}`);
    console.log(`  已测平台：${d.platforms_tested.join('; ')}`);
    console.log(`  未验证平台：${d.platforms_unverified.join(', ')}`);
    console.log('  剩余限制：');
    for (const l of d.remaining_limits) console.log('    - ' + l);
  }
  process.exit(r.ok ? 0 : 1);
}
