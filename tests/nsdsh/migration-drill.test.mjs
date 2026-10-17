/**
 * tests/nsdsh/migration-drill.test.mjs —— S16：迁移演练与灰度。
 *
 * 为什么不能只靠"幂等测试"：幂等证明"重复启动不出错"，但**升级已有旧库**还要回答
 * "数据还在吗 / schema 真的前进了吗 / 怎么退回去 / 灰度怎么做"。
 * 本套件钉住这四问，并额外钉住一条诚实性要求：
 * **灰度计划里必须有"未执行"的阶段**（脚本不得假装已经切换上线）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../temporal/harness.mjs';
import { REPO } from '../../scripts/nsdsh/lib/isolate.mjs';

const D = await import('../../scripts/nsdsh/migration-drill.mjs');

suite('nsdsh/migration-drill', [
  ['S16-D1 只操作副本：绝不碰作者真实 data/ 库', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts/nsdsh/migration-drill.mjs'), 'utf8');
    // 数据源必须是 .p1-baseline/data 的副本；数据目录必须是 mkdtemp 出来的临时目录
    assert.match(src, /\.p1-baseline['"],\s*'data['"],\s*'novel\.db'/, '只能读 .p1-baseline 的副本');
    assert.match(src, /mkdtempSync/, '必须在临时目录里演练');
    assert.match(src, /NOVELSTUDIO_DATA_DIR:\s*dataDir/, '迁移必须指向临时数据目录');
    // 不得出现指向真实 data/ 的写入
    assert.ok(!/path\.join\(REPO,\s*'data'/.test(src), '不得直接操作仓库的 data/ 目录');
  }],

  ['S16-D2 迁移真的前进了 schema，且账本被写入（不是"表建出来了"就算）', () => {
    const r = D.drill();
    assert.ok(r.drill, '必须有演练结果');
    assert.ok(r.drill.new_tables_added > 0, `必须新增表，实际 ${r.drill.new_tables_added}`);
    assert.ok(r.drill.ledger_rows > 0, `账本必须有记录，实际 ${r.drill.ledger_rows}`);
    assert.equal(r.drill.ledger_before, false, '旧库副本原本没有迁移账本（这正是要补的）');
    const ledgerCheck = r.checks.find((c) => /账本已建立/.test(c.name));
    assert.ok(ledgerCheck && ledgerCheck.ok);
  }],

  ['S16-D3 旧数据必须仍在（works / chapters 行数 > 0）', () => {
    const r = D.drill();
    assert.ok(r.drill.works_rows > 0, `works 行数为 ${r.drill.works_rows}，数据可能被清掉`);
    assert.ok(r.drill.chapters_rows > 0, `chapters 行数为 ${r.drill.chapters_rows}`);
    const c = r.checks.find((x) => /旧数据仍在/.test(x.name));
    assert.ok(c && c.ok, '必须有"旧数据仍在"的通过证据');
  }],

  ['S16-D4 幂等：第二次迁移不改账本、不重建表、库仍可打开', () => {
    const r = D.drill();
    for (const pat of [/幂等/, /不重复记账/, /表集合不变/, /可再次打开/]) {
      const c = r.checks.find((x) => pat.test(x.name));
      assert.ok(c, `缺少检查：${pat}`);
      assert.ok(c.ok, `检查未通过：${c.name} — ${c.detail}`);
    }
  }],

  ['S16-D5 回滚路径可执行：备份 + 摘要 + 具体步骤（不是"记得备份"）', () => {
    const r = D.drill();
    assert.ok(r.rollback, '必须产出回滚产物');
    assert.ok(fs.existsSync(r.rollback.backup), '备份文件必须真的存在');
    assert.match(r.rollback.backup_sha256, /^[0-9a-f]{64}$/, '必须有完整 sha256');
    assert.ok(r.rollback.steps.length >= 3, '回滚步骤必须具体');
    // 步骤里必须包含"校验摘要"这一步（否则备份本身不可信）
    assert.ok(r.rollback.steps.some((s) => /sha256|校验/.test(s)), '回滚步骤必须含摘要校验');
  }],

  ['S16-D6 灰度计划必须诚实：留下的阶段必须标为未执行', () => {
    const r = D.drill();
    assert.ok(Array.isArray(r.grayscale) && r.grayscale.length >= 3, '灰度计划至少三个阶段');
    const undone = r.grayscale.filter((g) => !g.done);
    assert.ok(undone.length >= 1, '必须至少有一个未执行阶段（脚本不得假装已切换上线）');
    // 未执行的那个必须是"切换后观察"这类需要真实环境的事
    assert.ok(undone.some((g) => /观察|切换/.test(g.name + g.detail)), `未执行阶段应属真实环境验证：${JSON.stringify(undone)}`);
    // 而前面的演练阶段必须真的做完
    const doable = r.grayscale.filter((g) => /副本演练|校验报告|切换前备份/.test(g.name));
    for (const g of doable) assert.equal(g.done, true, `可执行阶段必须完成：${g.name}`);
  }],
]);
