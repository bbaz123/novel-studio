import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hash = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const compact = (s) => s.replace(/\s+/gu, '');
const count = (s) => [...s].length; // Unicode code points，不能用作运行时JS span偏移。

function markedBlock(doc, tag, language) {
  const fence = '`'.repeat(3);
  const start = '<!-- BEGIN_' + tag + ' -->\n' + fence + language + '\n';
  const end = '\n' + fence + '\n<!-- END_' + tag + ' -->';
  const a = doc.indexOf(start);
  if (a < 0 || doc.indexOf(start, a + start.length) >= 0) {
    throw new Error(`起始标记缺失或重复: ${tag}`);
  }
  const b = doc.indexOf(end, a + start.length);
  if (b < 0 || doc.indexOf(end, b + end.length) >= 0) {
    throw new Error(`结束标记缺失或重复: ${tag}`);
  }
  return doc.slice(a + start.length, b); // 不trim、不改换行。
}

function checkOriginal(name, body, expected) {
  if (!expected || typeof expected.sha256 !== 'string') {
    throw new Error(`缺少原文校验信息: ${name}`);
  }
  if (hash(body) !== expected.sha256 || count(body) !== expected.chars ||
      count(compact(body)) !== expected.compact_chars) {
    throw new Error(`原文校验失败: ${name}`);
  }
}

function main() {
  const documentPath = path.resolve(process.argv[2] ?? '叙事性专项修复.md');
  const doc = fs.readFileSync(documentPath, 'utf8');
  const before = markedBlock(doc, 'ORIGINAL_BEFORE', 'text');
  const after = markedBlock(doc, 'ORIGINAL_AFTER', 'text');
  const manifest = JSON.parse(markedBlock(doc, 'DIFF_MANIFEST', 'json'));
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.changes) ||
      manifest.changes.length !== 6) {
    throw new Error('样本清单版本或差异数量不符');
  }
  checkOriginal('before', before, manifest.before);
  checkOriginal('after', after, manifest.after);

  let rebuilt = compact(before);
  for (const change of manifest.changes) {
    if (typeof change.before !== 'string' || typeof change.after !== 'string') {
      throw new Error(`差异字段类型错误: ${change.id}`);
    }
    const from = compact(change.before);
    const to = compact(change.after);
    const index = rebuilt.indexOf(from);
    if (!from || index < 0 || rebuilt.indexOf(from, index + from.length) >= 0) {
      throw new Error(`差异原句不唯一或不存在: ${change.id}`);
    }
    rebuilt = rebuilt.slice(0, index) + to + rebuilt.slice(index + from.length);
  }
  if (rebuilt !== compact(after)) {
    throw new Error('六组改动无法重建后稿，拒绝导出');
  }

  const target = path.resolve('tests/narrative-repair/fixtures');
  const outputs = [
    ['before.txt', before],
    ['after.txt', after],
    ['manifest.json', JSON.stringify(manifest, null, 2) + '\n'],
  ];
  // 预检全部文件；存在不同内容时不覆盖，避免将基线变化伪装为修复。
  for (const [name, content] of outputs) {
    const file = path.join(target, name);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || fs.readFileSync(file, 'utf8') !== content)) {
      throw new Error(`目标已存在且不是相同样本: ${file}`);
    }
  }
  fs.mkdirSync(target, { recursive: true });
  for (const [name, content] of outputs) {
    const file = path.join(target, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' });
  }
  console.log(JSON.stringify({
    status: 'passed',
    output_dir: target,
    before_sha256: hash(before),
    after_sha256: hash(after),
    verified_change_groups: manifest.changes.length,
    scope: 'fixture_integrity_only_not_novel_studio_tests',
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
