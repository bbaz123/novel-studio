#!/usr/bin/env node
/**
 * check-utf8.mjs —— 两种"编码类"缺陷的定点检查。
 *
 * ── A. 非法 UTF-8（混编码/GBK 残留）──────────────────────────────────────────
 * 由来：2026-09-16 自审发现 `.p1-baseline/.gitignore` 被 `Add-Content`（PS 5.1 默认 GBK）
 * 写成了 UTF-8/GBK 混编，连 `read` 工具都报 invalid UTF-8。
 * 这类损坏 **git 不会报错**（git 按字节存储），只能靠解码扫出来。
 *
 * ── B. PowerShell 脚本的 BOM 约定（2026-09-18 新增）─────────────────────────
 * 由来：本轮改 `install.ps1` 时，编辑工具把文件原有的 **UTF-8 BOM 抹掉了**。
 * 本机 `powershell.exe` 是 **5.1**，它把**无 BOM** 的文件按 **ANSI(GBK)** 解码：
 * 中文注释被误解码后，多字节序列会**吞掉紧随其后的 ASCII 字节**（引号、花括号），
 * 于是脚本报出 6 处语法错误——而用编辑器打开**完全看不出来**，只有真正执行才暴露。
 * 所以：**含非 ASCII 的 `.ps1` 必须带 BOM**（纯 ASCII 的不强制，避免无谓改动）。
 * 之前的扫描连 `.ps1` 都不在扩展名表里，这正是它没能拦住的原因。
 *
 * 用法:
 *   node .p1-baseline/check-utf8.mjs [根目录]   # 扫描（默认仓库根）
 *   node .p1-baseline/check-utf8.mjs --self-test # 只跑判据的自检 + 阴性对照
 */
import fs from 'node:fs';
import path from 'node:path';

const BOM = [0xef, 0xbb, 0xbf];
const hasBom = (buf) => buf.length >= 3 && buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2];
const hasNonAscii = (buf) => buf.some((b) => b >= 0x80);

/** 是否合法 UTF-8（TextDecoder 默认非致命会替换坏字节，所以用 fatal:true 试一遍）。 */
function isValidUtf8(buf) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; }
}

/** 该文件是否**必须**带 BOM 却没带：PowerShell 脚本 + 含非 ASCII + 无 BOM。 */
function bomRequiredButMissing(file, buf) {
  return path.extname(file).toLowerCase() === '.ps1' && hasNonAscii(buf) && !hasBom(buf);
}

/**
 * 已知豁免：P0 时代的 **dsh 输出原样捕获**（3 个）。
 * 它们是**证据**，不是源码——重写会把证据变成"我整理过的版本"，所以刻意不动、只登记。
 * 豁免是**显式清单**而不是"忽略所有非 UTF-8"：新出现的非法文件必须报出来。
 */
const KNOWN_EVIDENCE = new Set([
  '.p0-recon/headless-sim.p6.txt',
  '.p0-recon/headless.composed.txt',
  '.p0-recon/novel.p3.txt',
]);

if (process.argv.includes('--self-test')) {
  let pass = 0; const fails = [];
  const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fails.push(n); console.log(`  ✗ ${n}`); } };
  const b = (...bytes) => Buffer.from(bytes);
  console.log('【判据自检（每条都必须能失败，否则是恒真断言）】');
  ok('合法中文 UTF-8 → 判合法', isValidUtf8(Buffer.from('中文注释', 'utf8')) === true);
  ok('截断的多字节序列 → 判非法', isValidUtf8(b(0xe4, 0xb8)) === false);
  ok('阴性对照：纯 ASCII 也判合法（判据不是"见非 ASCII 就报"）', isValidUtf8(Buffer.from('abc', 'utf8')) === true);
  ok('含非 ASCII 的无 BOM .ps1 → 要求补 BOM',
    bomRequiredButMissing('x.ps1', Buffer.from('# 中文', 'utf8')) === true);
  ok('带 BOM 的同一文件 → 不再要求', bomRequiredButMissing('x.ps1', Buffer.concat([Buffer.from(BOM), Buffer.from('# 中文', 'utf8')])) === false);
  ok('纯 ASCII 的 .ps1 → 不强制（避免无谓改动）',
    bomRequiredButMissing('x.ps1', Buffer.from('Write-Host ok', 'utf8')) === false);
  ok('非 .ps1（如 .md/.mjs）→ 不适用该规则',
    bomRequiredButMissing('x.md', Buffer.from('# 中文', 'utf8')) === false);
  console.log(`\n${fails.length ? '✗' : '✓'} 自检 ${pass + fails.length} 条，通过 ${pass}，失败 ${fails.length}`);
  process.exitCode = fails.length ? 1 : 0;
} else {
  const ROOT = process.argv[2] || '.';
  // .ps1/.cmd 此前不在表里 —— PowerShell 脚本从没被编码检查覆盖过，这就是缺口本身。
  const EXTS = ['.mjs', '.js', '.md', '.yml', '.yaml', '.json', '.ts', '.html', '.css', '.txt', '.ps1', '.cmd', '.bat'];
  const SKIP = ['node_modules', '.git', 'data', 'gate-data', 'stress-data', 'suite-data', '.rehearsal', '.verify', '.blind', '.exp-settings', '.revert-matrix'];

  let bad = 0, bomMissing = 0, total = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (SKIP.includes(e.name)) continue;
      if (e.isDirectory()) { walk(p); continue; }
      if (!EXTS.includes(path.extname(e.name).toLowerCase())) continue;
      total++;
      const buf = fs.readFileSync(p);
      const rel = path.relative(ROOT, p).split(path.sep).join('/');
      if (!isValidUtf8(buf)) {
        if (KNOWN_EVIDENCE.has(rel)) {
          console.log(`  · ${rel}（已知证据捕获，刻意保留原样：${buf.length} 字节）`);
        } else {
          bad++;
          console.log(`  ✗ ${rel}（非法 UTF-8，${buf.length} 字节）`);
        }
      }
      if (bomRequiredButMissing(e.name, buf)) {
        bomMissing++;
        console.log(`  ✗ ${rel}（PowerShell 5.1 会按 ANSI 误读：含非 ASCII 却缺 UTF-8 BOM）`);
      }
    }
  };
  walk(ROOT);
  console.log(`\n扫描 ${total} 个文本文件：非法 UTF-8 ${bad} 个，缺 BOM 的 .ps1 ${bomMissing} 个。`);
  if (bad || bomMissing) {
    console.log('修法：非法 UTF-8 用编辑工具整份重写；缺 BOM 用 [System.IO.File]::WriteAllBytes 前置 EF BB BF（不要用 Set-Content）。');
  }
  process.exitCode = bad || bomMissing ? 1 : 0;
}
