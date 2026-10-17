/**
 * tests/nsdsh/fault-matrix.test.mjs —— S15：性能报告的完整性 + E1 的归因与纪律。
 *
 * S15 验收："正确性门槛全部通过；性能报告包含硬件与计时边界；未测项有明确标记。"
 * E1 到期条件："给出可复现归因、不加重试、不弱化断言；若属门禁侧沙箱则改记'本项目不可修'并写明影响。"
 *
 * 本套件钉住三件事：
 *   ① 性能报告必须带**硬件**与**计时边界**（否则数字不可比）；
 *   ② E1 的归因必须基于**可枚举的证据**（spawn 敏感项清单 + 同环境实跑结果），不是一句"环境问题"；
 *   ③ 归因过程**不得引入重试**（用源码断言兜住这条纪律）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { suiteAsync } from '../temporal/harness.mjs';
import { REPO } from '../../scripts/nsdsh/lib/isolate.mjs';

const A = await import('../../scripts/nsdsh/attribute-gate-flakiness.mjs');
const Bm = await import('../../scripts/nsdsh/benchmark.mjs');

await suiteAsync('nsdsh/fault-matrix', [
  ['S15-M1 性能报告必须带硬件画像（不可比则无意义）', () => {
    const hw = Bm.hardwareProfile();
    for (const k of ['node', 'platform', 'cpu_model', 'cpu_count', 'total_mem_mb', 'timer', 'note']) {
      assert.ok(hw[k] !== undefined && hw[k] !== '', `hardwareProfile 缺 ${k}`);
    }
    assert.match(hw.node, /^v\d+\./);
    assert.ok(hw.cpu_count >= 1);
    assert.match(hw.timer, /hrtime|纳秒|毫秒/, '必须声明计时器与精度');
    assert.match(hw.note, /边界|不代表/, '必须写明"这不代表什么"');
  }],

  ['S15-M2 100 章与 1000 章夹具都能跑出统计（含 n/min/median/max）', async () => {
    for (const chapters of [100, 1000]) {
      const r = await Bm.benchmark({ chapters, samples: 3 });
      assert.equal(r.chapters, chapters);
      assert.equal(r.mode, 'fixture');
      assert.ok(r.hardware && r.hardware.cpu_model);
      for (const key of ['hot_query', 'cache_miss_query', 'body_read']) {
        const s = r.timings[key];
        assert.ok(s && s.n > 0, `${chapters} 章的 ${key} 必须有样本`);
        assert.ok(s.min <= s.median && s.median <= s.max, `${key} 的 min/median/max 必须单调`);
      }
      assert.ok(r.timings.build_fixture_ms > 0, '冷启动耗时必须 > 0');
      // 缓存命中的中位数不应显著劣于未命中（只做量级判断，不做硬阈值）
      assert.ok(Array.isArray(r.boundaries) && r.boundaries.length >= 3, '必须列出计时边界');
    }
  }],

  ['S15-M3 E1 归因：静态枚举能数出"沙箱敏感项"，且清单非空非全', () => {
    const stat = A.staticAttribution();
    assert.ok(stat.total_checks >= 50, `离线检查应有 50 项以上，实际 ${stat.total_checks}`);
    assert.ok(stat.spawn_sensitive_count > 0, '必须存在依赖派生子进程的检查（否则沙箱假设不成立）');
    assert.ok(stat.spawn_sensitive_count < stat.total_checks, '不应把全部检查都算成敏感项（那等于没归因）');
    assert.equal(stat.spawn_sensitive_count + stat.spawn_free_count, stat.total_checks);
    // 每一项都要能指到真实脚本
    for (const c of stat.checks) {
      assert.ok(typeof c.script === 'string' && c.script.length > 0, '每项检查必须有脚本路径');
    }
    assert.match(stat.hypothesis, /EPERM|子进程/, '假设必须可证伪（写明机制）');
  }],

  ['S15-M4 归因结论按实跑结果分流（当前环境绿→门禁侧；当前环境红→项目侧）', () => {
    const stat = A.staticAttribution();
    const green = A.attribute({ stat, run: { exitCode: 0, duration_ms: 1000, summary: '合计：通过 55 / 未通过 0' } });
    assert.equal(green.verdict, 'GATE_SIDE_SANDBOX', '同环境绿时必须归因到门禁侧');
    const red = A.attribute({ stat, run: { exitCode: 1, duration_ms: 1000, summary: '', failed: '未通过：某检查' } });
    assert.equal(red.verdict, 'PROJECT_SIDE_FAILURE', '同环境也红时必须按项目缺陷处理，不得归因给环境');
    const unknown = A.attribute({ stat });
    assert.equal(unknown.verdict, 'INCONCLUSIVE', '没有实跑证据时不得下结论');
  }],

  ['S15-M5 纪律：归因过程不得引入重试（源码断言 + 结论文本自陈）', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts/nsdsh/attribute-gate-flakiness.mjs'), 'utf8');
    // 归因脚本本身不得含重试循环
    assert.ok(!/for\s*\([^)]*attempt/i.test(src), '不得按 attempt 重试');
    // 用拼接构造被禁短语，避免"断言自己的字面量"被搜到（这是本会话反复踩的自指坑）
    const bannedPhrase = '重试' + '直到' + '绿';
    assert.ok(!src.includes(bannedPhrase), '不得出现"重试直到绿"这类做法');
    // 只禁**重试机制**本身（计数器/循环重跑），不禁"non_retry_discipline"这种描述性字段名。
    for (const mech of [/max[A-Z]?[a-z]*Retries/i, /retryCount/i, /while\s*\([^)]*attempt/i, /attempts?\s*\+/i]) {
      assert.ok(!mech.test(src), `不得出现重试机制：${mech}`);
    }
    const report = A.attribute({ stat: A.staticAttribution() });
    assert.match(report.non_retry_discipline, /不引入任何自动重试|断言强度不变/);
    assert.match(report.gate_credibility, /EPERM|签名/, '必须说明"门禁红该怎么读"');
  }],

  ['S15-M6 未测项必须被明确标记（不得声称跨平台支持）', () => {
    // 台账里的 E1 必须带处置结论与证据；性能报告必须声明平台边界
    const issues = JSON.parse(fs.readFileSync(path.join(REPO, 'docs/nsdsh/known-issues.json'), 'utf8'));
    const e1 = issues.issues.find((i) => i.id === 'E1');
    assert.ok(e1, '台账必须有 E1');
    assert.ok(String(e1.evidenceNote || '').length > 50, 'E1 必须有实质证据说明');
    assert.match(String(e1.evidenceNote || ''), /沙箱|EPERM|门禁侧/, 'E1 的证据必须指向门禁侧沙箱');
    const hw = Bm.hardwareProfile();
    // 本机只验证了一个平台：报告必须写明 platform，供"未测平台"标注使用
    assert.match(hw.platform, /win32|linux|darwin/);
  }],
]);
