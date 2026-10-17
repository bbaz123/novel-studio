/**
 * tests/nsdsh/bridge-retirement.test.mjs —— S17：旧桥接退役与上游维护纪律。
 *
 * S17 验收三条，逐条变成断言：
 *   ① **没有两个调度所有者** —— 只能有一个"谁来决定何时跑分析"的地方；
 *   ② **没有 import 时修改用户全局设置** —— 导入一个模块不能顺手改用户的 DSH 设置；
 *   ③ **上游更新能追踪补丁来源** —— 升级流程与补丁位置有文档、有校验脚本。
 *
 * 其中 ② 是本轮真正修掉的缺陷：`restoreHarnessSettingsIfNeeded()` 原本在
 * `harness.js` 的**模块顶层**调用，于是 `import('./harness.js')` 这个只读动作会
 * 写用户的 `settings.yaml`。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { suiteAsync } from '../temporal/harness.mjs';
import { REPO } from '../../scripts/nsdsh/lib/isolate.mjs';

const harnessSrc = fs.readFileSync(path.join(REPO, 'harness.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

await suiteAsync('nsdsh/bridge-retirement', [
  ['S17-B1 只有一个调度所有者（旧的 timer + schedule 已退役）', () => {
    // 旧的进程内调度器必须彻底消失：不能有它的定义/调用
    assert.ok(!/function\s+scheduleTemporalAnalysis\s*\(/.test(serverSrc), 'scheduleTemporalAnalysis 必须已删除');
    assert.ok(!/temporalAnalysisQueue\s*=\s*\[/.test(serverSrc), '旧的数组式队列必须已删除');
    assert.ok(!/setTimeout\(\s*scheduleTemporalAnalysis/.test(serverSrc), '不得还有基于 setTimeout 的再排期');

    // 唯一的所有者：写入意图（queue-store）+ 事务外领取（dispatcher）
    assert.match(serverSrc, /recordAnalysisIntent\(/, '必须通过 queue-store 写意图');
    assert.match(serverSrc, /function startTemporalDispatcher\(/, '必须有唯一的分发者');
    // 分发者只应被启动一次
    const starts = [...serverSrc.matchAll(/startTemporalDispatcher\(\)/g)].length;
    assert.equal(starts, 2, `startTemporalDispatcher 应只有 1 处定义外的调用（实际出现 ${starts} 次：定义+调用）`);
  }],

  ['S17-B2 导入模块不得修改用户全局设置（顶层副作用已移除）', () => {
    // ① 静态：顶层不得再出现裸调用
    const lines = harnessSrc.split('\n');
    const bareTopLevel = lines.findIndex((l) => /^restoreHarnessSettingsIfNeeded\(\);/.test(l.trim()));
    assert.equal(bareTopLevel, -1, 'restoreHarnessSettingsIfNeeded() 不得在模块顶层裸调用');
    // ② 必须改成显式引导函数
    assert.match(harnessSrc, /export function bootstrapHarnessSettings\(/, '必须导出显式的启动引导');
    // ③ 真实启动路径必须调用它
    assert.match(serverSrc, /bootstrapHarnessSettings\(\)/, 'server.js 启动时必须显式调用引导');
    // ④ 引导必须包在 try/catch 里（引导失败不影响启动）
    const bootBody = harnessSrc.slice(harnessSrc.indexOf('export function bootstrapHarnessSettings('));
    assert.match(bootBody.slice(0, 300), /try\s*\{[\s\S]*catch/, '引导失败不得抛出');
  }],

  ['S17-B3 动态证明：import 一次 harness.js 不写任何设置文件', async () => {
    // 用隔离的 DSH_HOME / 主目录，导入前后对比文件集合与内容
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-import-probe-'));
    const dshHome = path.join(tmp, '.dsh');
    fs.mkdirSync(dshHome, { recursive: true });
    const settings = path.join(dshHome, 'settings.yaml');
    const sentinel = '# sentinel: 导入不得改写这一行\nmodel: probe\n';
    fs.writeFileSync(settings, sentinel, 'utf8');

    const before = fs.readFileSync(settings, 'utf8');
    const beforeList = fs.readdirSync(dshHome).sort();

    // 在隔离环境里真正 import 一次（子进程，避免污染本进程模块缓存）
    const { execFileSync } = await import('node:child_process');
    const script = `process.env.DSH_HOME=${JSON.stringify(dshHome)};` +
      `import(${JSON.stringify('file:///' + path.join(REPO, 'harness.js').replace(/\\/g, '/'))})` +
      `.then(()=>process.exit(0)).catch((e)=>{console.error(String(e&&e.message||e));process.exit(3)})`;
    let importOk = true;
    let importErr = '';
    try {
      execFileSync(process.execPath, ['-e', script], { cwd: REPO, env: { ...process.env, DSH_HOME: dshHome }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { importOk = false; importErr = String(e.stderr || e.message).split('\n').pop(); }

    assert.equal(importOk, true, `import harness.js 本身不应失败：${importErr}`);
    assert.equal(fs.readFileSync(settings, 'utf8'), before, 'import 不得改动 settings.yaml');
    assert.deepEqual(fs.readdirSync(dshHome).sort(), beforeList, 'import 不得新增/删除用户目录里的文件');
    fs.rmSync(tmp, { recursive: true, force: true });
  }],

  ['S17-B4 上游维护纪律有文档，且覆盖"补丁来源可追踪"', () => {
    const docPath = path.join(REPO, 'docs/nsdsh/upstream-maintenance.md');
    assert.ok(fs.existsSync(docPath), '必须有 docs/nsdsh/upstream-maintenance.md');
    const doc = fs.readFileSync(docPath, 'utf8');
    for (const must of ['拉取候选', '重放补丁', '构建完整基线', '回归', '发布']) {
      assert.ok(doc.includes(must), `升级流程必须包含「${must}」`);
    }
    // 补丁来源追踪：目录约定 + 校验脚本
    assert.match(doc, /vendor\/dsh\/patches/, '必须约定补丁目录');
    assert.match(doc, /sha256/, '必须记录补丁摘要');
    assert.match(doc, /verify-vendor/, '必须指向校验脚本');
    // 明确"不删基线掩盖回归"
    assert.match(doc, /不删除\s*`?\.p1-baseline/, '必须写明不删除历史记录掩盖回归');
  }],

  ['S17-B5 不删已有承诺：仍有 external adapter 与 adapter 契约测试', () => {
    // S17 动作 3：不为"代码更少"牺牲已承诺功能
    assert.ok(fs.existsSync(path.join(REPO, 'ai/model-broker/adapters.mjs')), 'adapter 契约模块必须仍在');
    const adapters = fs.readFileSync(path.join(REPO, 'ai/model-broker/adapters.mjs'), 'utf8');
    assert.match(adapters, /createDirectAdapter/, 'direct adapter 必须保留');
    assert.match(adapters, /createLegacyAdapter/, 'legacy adapter 必须保留（已承诺的兼容路径）');
    assert.ok(fs.existsSync(path.join(REPO, 'tests/nsdsh/runtime-adapter-contract.test.mjs')), 'adapter 契约测试必须保留');
  }],
]);
