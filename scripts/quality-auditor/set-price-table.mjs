#!/usr/bin/env node
/**
 * set-price-table.mjs —— 配置审计的**可信价目表**（`app_settings.audit_price_table`）。
 *
 * 为什么必须由人来配：服务端拿不到模型定价的权威来源，按字数猜价格会让门禁变成
 * "看起来在预算内"的假保证（budget.mjs 开头的红线）。所以价目表只有两种状态：
 *   · 配置了 → 审计跑完可把"实际费用"折算出来并落账；
 *   · 没配置 → 一律显示"实际费用未知"，绝不填 0。
 *
 * 用法：
 *   node scripts/quality-auditor/set-price-table.mjs --show
 *   node scripts/quality-auditor/set-price-table.mjs --set '{"deepseek-flash":{"input_cny_per_1k":0.0005,"output_cny_per_1k":0.002}}'
 *   node scripts/quality-auditor/set-price-table.mjs --set-file <path.json>
 *   node scripts/quality-auditor/set-price-table.mjs --clear
 *
 * 单位：人民币元 / 1K tokens（输入、输出分别给）。
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { normalizePriceTable } from '../../ai/quality-auditor/usage.mjs';

// 参数解析：同时支持 `--key=value` 与 `--key value`（后者是价目表这种长 JSON 的常态写法）。
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i += 1) {
  const a = String(argv[i]);
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  if (eq !== -1) { args[a.slice(2, eq)] = a.slice(eq + 1); continue; }
  const next = argv[i + 1];
  if (next != null && !String(next).startsWith('--')) { args[a.slice(2)] = String(next); i += 1; }
  else args[a.slice(2)] = 'true';
}

const dbPath = process.env.NOVELSTUDIO_DATA_DIR
  ? `${process.env.NOVELSTUDIO_DATA_DIR}/novel.db`
  : 'data/novel.db';
if (!fs.existsSync(dbPath)) { console.error(`✗ 找不到数据库：${dbPath}`); process.exit(2); }
const db = new DatabaseSync(dbPath);

const read = () => {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('audit_price_table');
  if (!row || !row.value) return null;
  try { return JSON.parse(String(row.value)); } catch { return null; }
};

const write = (value) => {
  if (value == null) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('audit_price_table');
    return;
  }
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('audit_price_table', JSON.stringify(value));
};

if (args.clear) {
  write(null);
  console.log('✓ 已清除价目表：审计费用将显示「实际费用未知」（旧账不追溯）');
  process.exit(0);
}

const rawJson = args['set-file']
  ? fs.readFileSync(String(args['set-file']), 'utf8')
  : (args.set && args.set !== 'true' ? String(args.set) : '');

if (rawJson) {
  let parsed = null;
  try { parsed = JSON.parse(rawJson); } catch (e) {
    console.error('✗ 价目表不是合法 JSON：' + (e && e.message));
    process.exit(2);
  }
  const table = normalizePriceTable(parsed);
  if (!table) {
    console.error('✗ 价目表不可用：每个型号必须同时给非负的 input_cny_per_1k 与 output_cny_per_1k');
    process.exit(2);
  }
  write(table);
  console.log('✓ 已写入价目表：');
  for (const [model, p] of Object.entries(table)) {
    console.log(`  · ${model}：入 ¥${p.input_cny_per_1k}/1k tok，出 ¥${p.output_cny_per_1k}/1k tok`);
  }
  console.log('（只影响**之后**跑完的审计；已经跑完的保持原值，不追溯改写）');
  process.exit(0);
}

// 默认：显示当前配置
const cur = normalizePriceTable(read());
if (!cur) {
  console.log('当前没有价目表：审计跑完会显示「实际费用未知（未配置价目表）」，不会填 0。');
  console.log('示例：--set \'{"deepseek-flash":{"input_cny_per_1k":0.0005,"output_cny_per_1k":0.002}}\'');
} else {
  console.log('当前价目表：');
  for (const [model, p] of Object.entries(cur)) {
    console.log(`  · ${model}：入 ¥${p.input_cny_per_1k}/1k tok，出 ¥${p.output_cny_per_1k}/1k tok`);
  }
}
