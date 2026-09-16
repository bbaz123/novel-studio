#!/usr/bin/env node
/**
 * 组合树对账工具 —— 比较两份 `dsh --profile <name> --dump-config` 的输出。
 *
 * 用途：P0 验证「novel profile 与 headless profile 功能等价」。dsh 的组合树是
 * 顶层 YAML 序列，条目之间夹着 `# == <layer>` 注释标明来源层；本站不使用 YAML
 * 解析器（避免任何依赖），改为按「列 0 的 `- ` 起始行」切块，再逐块取 id /
 * disabled / 归一化正文。
 *
 * 为什么不用启发式窗口扫描：曾用「id 行后 5 行内找 disabled」的实现，漏掉了
 * `disabled: true` 写在 config 块之后的条目（session-title-llm），导致误判。
 * 本工具按整块取值，不受字段顺序影响。
 *
 * 用法：node compare-composed.mjs <baseline.txt> <candidate.txt> [--verbose]
 */

import fs from 'node:fs';

const ID_RE = /\bid:\s*'?([A-Za-z0-9._@/-]+)'?/;
const DISABLED_RE = /\bdisabled:\s*true\b/;
const LAYER_RE = /^#\s*==\s*(.*)$/;

/** 把一份 dump 切成顶层条目数组。 */
function parseEntries(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let layer = '';
  let cur = null;

  for (const line of lines) {
    const layerMatch = line.match(LAYER_RE);
    if (layerMatch) {
      layer = layerMatch[1].trim();
      continue;
    }
    // 顶层条目 = 列 0 的 `- `；缩进的嵌套条目归属当前块。
    if (/^-\s/.test(line)) {
      if (cur) entries.push(cur);
      cur = { layer, lines: [line] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) entries.push(cur);

  return entries.map((entry, index) => {
    const body = entry.lines.join('\n');
    const idMatch = body.match(ID_RE);
    return {
      index,
      id: idMatch ? idMatch[1] : '(no-id)',
      disabled: DISABLED_RE.test(body),
      layer: entry.layer,
      body: body.trim(),
    };
  });
}

/**
 * 读取文本并识别编码。
 * 必须容错：Windows PowerShell 5.1 的 `>` / `*>` 重定向默认写 UTF-16LE，
 * 而 node 的 stdout 是 UTF-8。曾因按 UTF-8 读 UTF-16LE 快照导致「0 行」误判。
 */
function readText(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le').replace(/^\uFEFF/, '');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf);
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const t = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = t;
    }
    return swapped.toString('utf16le').replace(/^\uFEFF/, '');
  }
  const s = buf.toString('utf8');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 把正文归一化：去行尾空白、压掉空行，便于比对。 */
function normalize(body) {
  return body
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
    .join('\n');
}

function main() {
  const [, , baselinePath, candidatePath, ...flags] = process.argv;
  const verbose = flags.includes('--verbose');
  if (!baselinePath || !candidatePath) {
    console.error('用法: node compare-composed.mjs <baseline.txt> <candidate.txt> [--verbose]');
    process.exit(2);
  }

  const base = parseEntries(readText(baselinePath));
  const cand = parseEntries(readText(candidatePath));

  // --list：只列一份快照的条目与 disabled 状态。
  if (flags.includes('--list')) {
    console.log(`${baselinePath}: ${base.length} rows, ${base.filter((e) => e.disabled).length} disabled`);
    console.log('disabled:');
    for (const e of base.filter((x) => x.disabled)) console.log(`  - ${e.id}`);
    console.log('enabled:');
    console.log('  ' + base.filter((e) => !e.disabled).map((e) => e.id).join(', '));
    process.exit(0);
  }

  // --check-disables <patch.yml>：检查 patch 里声明的 disabled id 是否真的在组合树中生效。
  // 若声明的 id 在组合树里不存在，dsh 不会报错——两边会「同样地不生效」，
  // 因此等价对账查不出这类静默失效，必须单独校验。
  const patchIdx = flags.indexOf('--check-disables');
  if (patchIdx !== -1) {
    const patchPath = flags[patchIdx + 1];
    if (!patchPath) {
      console.error('--check-disables 需要一个 patch 文件路径');
      process.exit(2);
    }
    const declared = parseEntries(readText(patchPath))
      .filter((e) => e.disabled)
      .map((e) => e.id);
    const effective = new Set(base.filter((e) => e.disabled).map((e) => e.id));
    const present = new Set(base.map((e) => e.id));
    const silentMiss = declared.filter((id) => !effective.has(id));
    const notInTree = declared.filter((id) => !present.has(id));

    console.log(`patch 声明 disabled : ${declared.length} -> ${declared.join(', ')}`);
    console.log(`组合树实际 disabled : ${effective.size}`);
    console.log('');
    console.log(`声明但未生效        : ${silentMiss.length}${silentMiss.length ? ' -> ' + silentMiss.join(', ') : ''}`);
    console.log(`  其中条目根本不存在: ${notInTree.length}${notInTree.length ? ' -> ' + notInTree.join(', ') : ''}`);
    console.log('');
    console.log(`结论: ${silentMiss.length === 0 ? 'ALL-DECLARED-DISABLES-EFFECTIVE' : 'SILENT-FAILURES-PRESENT'}`);
    process.exit(silentMiss.length === 0 ? 0 : 1);
  }

  if (base.length === 0 || cand.length === 0) {
    console.error(
      `解析到 0 个条目（baseline=${base.length}, candidate=${cand.length}）——快照可能是空文件或编码异常，请先核对快照本身。`
    );
    process.exit(3);
  }

  const baseById = new Map(base.map((e) => [e.id, e]));
  const candById = new Map(cand.map((e) => [e.id, e]));

  const onlyBase = base.filter((e) => !candById.has(e.id));
  const onlyCand = cand.filter((e) => !baseById.has(e.id));

  const disabledDiff = [];
  const bodyDiff = [];
  for (const b of base) {
    const c = candById.get(b.id);
    if (!c) continue;
    if (b.disabled !== c.disabled) {
      disabledDiff.push({ id: b.id, baseline: b.disabled, candidate: c.disabled });
    }
    if (normalize(b.body) !== normalize(c.body)) {
      bodyDiff.push({ id: b.id, baseline: b.body, candidate: c.body });
    }
  }

  const orderSame =
    base.length === cand.length && base.every((e, i) => cand[i] && cand[i].id === e.id);

  const out = [];
  out.push(`baseline : ${baselinePath}  (${base.length} rows, ${base.filter((e) => e.disabled).length} disabled)`);
  out.push(`candidate: ${candidatePath}  (${cand.length} rows, ${cand.filter((e) => e.disabled).length} disabled)`);
  out.push('');
  out.push(`条目顺序一致      : ${orderSame ? 'YES' : 'NO'}`);
  out.push(`仅 baseline 有    : ${onlyBase.length}${onlyBase.length ? ' -> ' + onlyBase.map((e) => e.id).join(', ') : ''}`);
  out.push(`仅 candidate 有   : ${onlyCand.length}${onlyCand.length ? ' -> ' + onlyCand.map((e) => e.id).join(', ') : ''}`);
  out.push(`disabled 标志不一致: ${disabledDiff.length}`);
  for (const d of disabledDiff) {
    out.push(`   - ${d.id}: baseline=${d.baseline} candidate=${d.candidate}`);
  }
  out.push(`正文不一致        : ${bodyDiff.length}`);
  for (const d of bodyDiff) {
    const bl = d.baseline.split('\n').length;
    const cl = d.candidate.split('\n').length;
    out.push(`   - ${d.id}  (baseline ${bl} 行 / candidate ${cl} 行)`);
    if (verbose) {
      out.push('     --- baseline ---');
      out.push(d.baseline.split('\n').map((l) => '     ' + l).join('\n'));
      out.push('     --- candidate ---');
      out.push(d.candidate.split('\n').map((l) => '     ' + l).join('\n'));
    }
  }

  const equivalent =
    orderSame && onlyBase.length === 0 && onlyCand.length === 0 && disabledDiff.length === 0 && bodyDiff.length === 0;

  // 让「正文不一致但仅因基线层级标注不同」的噪声可辨：列出各条目的来源层。
  if (!equivalent && !verbose) {
    out.push('');
    out.push('提示：加 --verbose 可打印不一致条目的完整正文。');
  }
  out.push('');
  out.push(`结论: ${equivalent ? 'EQUIVALENT（完全等价）' : 'DIFFERENT（存在差异）'}`);

  console.log(out.join('\n'));
  process.exit(equivalent ? 0 : 1);
}

main();
