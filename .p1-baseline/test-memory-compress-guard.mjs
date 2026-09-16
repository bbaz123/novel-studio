#!/usr/bin/env node
/**
 * test-memory-compress-guard.mjs —— 决策 D8-#3 的零损失护栏离线单测（零成本）。
 *
 * 被验证的行为：**压缩结果丢了关键实体时必须拒绝落库**，而不是静默保存一段通顺但缺东西的摘要。
 * 长期记忆会喂给之后每一章，丢一次影响所有后续章节，且不会报错——这是最难发现的一类损失。
 *
 * 阴性对照：把护栏的判据换成"看长度就放行"（即修复前的行为），
 * 同一组用例里"丢了角色名但字数够"的那条必须**被它放过**——证明这组用例确实在考"实体核对"，
 * 而不是靠字数顺带通过。
 *
 * 用法: node .p1-baseline/test-memory-compress-guard.mjs
 */
import { checkCompression, checkNoInvention, mustKeepEntities, partitionByAppearance, entityVariants, MIN_COMPRESSED_CHARS } from '../ai/memory-compress-guard.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

const ENTITIES = ['沈砚', '林晚', '拾线坊', '潮雾规则'];
// ⚠️ 覆盖率下限在测试里**钉死为 1**：它是一个可按环境变量放宽的策略值
// （`NOVELSTUDIO_COMPRESS_MIN_COVERAGE`），若测试依赖环境默认值，
// 外部一放宽，这里"必须拒绝"的断言就会集体假失败。测试要考的是判据本身，不是当前配置。
const strict = (o) => checkCompression({ ...o, minCoverage: 1 });
// ⚠️ 夹具里的实体必须**只出现一次**，否则"删掉它"的用例会因为重复出现而失败——
// 第一版就是用 padEnd 把「潮雾规则」重复填充了多次，于是 replace 只换掉第一处，
// 实体仍然找得到。夹具写错会让测试报假失败（这次就是）。
const GOOD = '沈砚在拾线坊替人补记忆。林晚带来一桩失踪案，一切按潮雾规则行事。'
  + '他补记忆时才发现，被缝回去的东西并不总是原来的样子。'.repeat(4);

console.log('【1. 正例：实体齐全、字数够 → 放行】');
{
  const r = checkCompression({ compressed: GOOD, mustKeep: ENTITIES });
  ok('判为通过', r.ok === true, JSON.stringify(r.reasons));
  ok('核对过的实体数如实回报', r.checked === 4, `checked=${r.checked}`);
  ok('回报压缩后字数', r.length === GOOD.trim().length, `length=${r.length}`);
}

console.log('\n【2. 反例：丢实体 / 空 / 过短 → 必须拒绝】');
{
  const dropChar = strict({ compressed: GOOD.replace('林晚', '那位记者'), mustKeep: ENTITIES });
  ok('丢掉角色名 → 拒绝，且指出丢了谁',
    dropChar.ok === false && dropChar.missing.includes('林晚'), JSON.stringify(dropChar.missing));

  const dropWorld = strict({ compressed: GOOD.replace(/潮雾规则/g, '某种规则'), mustKeep: ENTITIES });
  ok('丢掉世界观词条 → 拒绝', dropWorld.ok === false && dropWorld.missing.includes('潮雾规则'));

  const empty = strict({ compressed: '   ', mustKeep: ENTITIES });
  ok('空结果 → 拒绝（而不是当成"没丢实体"放行）', empty.ok === false && /为空/.test(empty.reasons.join()));

  const short = strict({ compressed: '沈砚 林晚 拾线坊 潮雾规则', mustKeep: ENTITIES });
  ok('实体齐全但过短 → 仍然拒绝（装不下角色状态与伏笔）',
    short.ok === false && /过短/.test(short.reasons.join()), JSON.stringify(short.reasons));

  const nullish = strict({ compressed: null, mustKeep: ENTITIES });
  ok('null 结果 → 拒绝（不抛异常，也不放行）', nullish.ok === false && nullish.length === 0);
}

console.log('\n【3. 边界：空实体名不能造成"永远通过"】');
{
  // 空串 `''` 包含于任何字符串 —— 若不过滤，mustKeep 里混进空串就等于没检查。
  const r = checkCompression({ compressed: GOOD, mustKeep: ['', '  ', '沈砚'] });
  ok('空白实体被过滤掉，只核对真实条目', r.checked === 1, `checked=${r.checked}`);
  const r2 = checkCompression({ compressed: GOOD, mustKeep: [] });
  ok('没有必须保留项时不误判失败', r2.ok === true, JSON.stringify(r2.reasons));
  const dup = checkCompression({ compressed: GOOD, mustKeep: ['沈砚', '沈砚'] });
  ok('重复实体去重（不做重复劳动）', dup.checked === 1, `checked=${dup.checked}`);
}

console.log('\n【4. 真实数据教出来的假阳性：带括号别名的名字，模型写简称不算丢】');
{
  // 2026-09-16 一次真实压缩调用：护栏把 11 个角色判成"丢失"并拒绝了整次压缩，
  // 而模型写的是 `乔明山"乔半醒"`、`小满`、`老葛` —— **人一个没丢**。
  // 逐字比对带注脚的完整串 = 要求模型照抄我们的写法，那是假阳性，不是零损失。
  const mustKeep = [
    '乔明山（社里人称"乔半醒"）', '小满（本名满秋）',
    '葛大勇（街坊喊"老葛"）', '旧日支配者（海澜市地底沉睡的那一位；仪式者只敢称"祂"）',
  ];
  const likeModelWrote = '乔明山"乔半醒"仍在每日探视；小满撞见路灯人影；老葛令其暂别城西。祂已能直接低语蛊惑普通人。'
    + '补记忆时才发现，被缝回去的东西并不总是原来的样子。'.repeat(4);
  const r = checkCompression({ compressed: likeModelWrote, mustKeep });
  ok('模型用简称写 → 判为没丢（修复前这里会全部误报）', r.ok === true, JSON.stringify(r.missing));
  ok('四个实体全部算作保留', r.kept === 4 && r.checked === 4, `kept=${r.kept}/${r.checked}`);

  // 要把一个实体"真的弄丢"，得把它的**所有写法**都换掉——
  // 只换主名而留着别名，实体其实还在（这正是变体匹配的意义）。
  const reallyDropped = likeModelWrote
    .replace('小满', '有人').replace('老葛', '某人')
    .replace('乔明山', '一位老人').replace('乔半醒', '某人')
    .replace(/祂/g, '它');
  const r2 = strict({ compressed: reallyDropped, mustKeep });
  ok('把每个实体的所有写法都换掉 → 全部判为丢失',
    r2.ok === false && r2.missing.length === 4, JSON.stringify(r2.missing));

  // 反向：只换主名、留着别名 → 应当**不**判丢失（否则又会退回逐字比对的假阳性）。
  const aliasOnly = likeModelWrote.replace('乔明山', '一位老人');
  const r3 = checkCompression({ compressed: aliasOnly, mustKeep });
  ok('只换主名、别名还在 → 不算丢（变体匹配没有被这次收紧改坏）',
    !r3.missing.includes('乔明山（社里人称"乔半醒"）'), JSON.stringify(r3.missing));

  // 变体拆分本身也要钉住：别名那一侧的碎片不能混进来（否则判据会被噪声放松）。
  ok('拆分出主名与别名',
    JSON.stringify(entityVariants('乔明山（社里人称"乔半醒"）')) === JSON.stringify(['乔明山', '乔半醒']));
  ok('长括号描述不产生"名字碎片"',
    !entityVariants('旧日支配者（海澜市地底沉睡的那一位；仪式者只敢称"祂"）').some((v) => v.length > 6));
  ok('无别名的名字只有一个写法', JSON.stringify(entityVariants('岳宸炎')) === JSON.stringify(['岳宸炎']));
}

console.log('\n【5. 阴性对照：换成"只看长度"的判据，必须放过丢实体那条】');
{
  const lengthOnly = ({ compressed, minChars = MIN_COMPRESSED_CHARS }) => String(compressed ?? '').trim().length >= minChars;
  const dropped = GOOD.replace('林晚', '那位记者');
  ok('对照判据确实放过"字数够但丢了角色名"的结果（这正是要防的失败模式）',
    lengthOnly({ compressed: dropped }) === true);
  ok('真护栏抓住同一条（否则前面测的是空气）',
    strict({ compressed: dropped, mustKeep: ENTITIES }).ok === false);
}

console.log('\n【6. mustKeepEntities：从作品数据算出必须保留项】');
{
  const list = mustKeepEntities({
    characters: [{ name: '沈砚' }, { name: ' 林晚 ' }, { name: '' }],
    worldEntries: [{ title: '潮雾规则' }, { title: null }],
  });
  ok('收集角色名与世界观标题并 trim、去空', JSON.stringify(list) === JSON.stringify(['沈砚', '林晚', '潮雾规则']),
    JSON.stringify(list));
  ok('缺字段时不崩', mustKeepEntities({}).length === 0 && mustKeepEntities().length === 0);
}

console.log('\n【7. 接线：压缩路径真的用了护栏，且失败不落库】');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync('server.js', 'utf8');
  ok('导入了护栏', /from '\.\/ai\/memory-compress-guard\.mjs'/.test(src));
  const i = src.indexOf('async function compressStoryMemory(');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  ok('压缩后先过护栏', /checkCompression\(\{/.test(body));
  ok('护栏不通过时**抛错**（作业会显示失败，而不是静默保存）',
    /MEMORY_COMPRESS_GUARD/.test(body) && /throw err/.test(body));
  const saveIdx = body.indexOf('saveStoryMemory(');
  const guardIdx = body.indexOf('checkCompression(');
  ok('顺序正确：先护栏、后落库', guardIdx > 0 && saveIdx > guardIdx, `guard@${guardIdx} save@${saveIdx}`);
  ok('必须保留项取自**出场侧**的角色与世界观（不是整张表）',
    /mustKeepEntities\(\{ characters: cast\.appearedChars, worldEntries: cast\.appearedWorlds \}\)/.test(body));
  ok('护栏结论落日志（通过与被拒都要留痕）',
    /memory_compress_ok/.test(body) && /memory_compress_rejected/.test(body));
}

console.log('\n【8. 按"出场没有"分两侧（用户 2026-09-16 规格；真实数据 23 个里只有 5 个出过场）】');
{
  const characters = [
    { name: '岳宸炎' }, { name: '林晚萤' }, { name: '卫文安' },
    { name: '乔明山（社里人称"乔半醒"）' }, { name: '白婆婆（本名白秀兰）' },
    { name: '从未登场的甲' }, { name: '从未登场的乙' },
  ];
  const worldEntries = [{ title: '守护者协议' }, { title: '没出现过的设定' }];
  const chapterText = '岳宸炎在教室醒来。林晚萤替他作伪证。班主任卫文安察觉异常。'
    + '乔半醒每日探视。白婆婆复述塌前地声。守护者协议启动。';

  const c = partitionByAppearance({ characters, worldEntries, chapterText });
  ok('出场角色被正确识别（5 个）', c.appearedChars.length === 5,
    c.appearedChars.map((x) => x.name).join('、'));
  ok('从未出场的角色被分到另一侧（2 个）', c.absentChars.length === 2,
    c.absentChars.map((x) => x.name).join('、'));
  ok('别名也算出场（章节只写"乔半醒"或"白婆婆"）',
    c.appearedChars.some((x) => x.name.startsWith('乔明山')) && c.appearedChars.some((x) => x.name.startsWith('白婆婆')));
  ok('世界观同样分两侧', c.appearedWorlds.length === 1 && c.absentWorlds.length === 1,
    `出场 ${c.appearedWorlds.map((w) => w.title)} / 未出场 ${c.absentWorlds.map((w) => w.title)}`);

  // 两侧判据要能真的拦住东西——否则分了侧也没用。
  const good = '岳宸炎与林晚萤、卫文安同行；乔半醒每日探视；白婆婆复述地声；守护者协议启动。'.repeat(6);
  const strictOnCast = checkCompression({
    compressed: good, minCoverage: 1,
    mustKeep: mustKeepEntities({ characters: c.appearedChars, worldEntries: c.appearedWorlds }),
  });
  ok('只按"出场过的"核对 → 好摘要通过（旧做法拿整表核对会误判）', strictOnCast.ok === true,
    JSON.stringify(strictOnCast.reasons));

  const withGhost = good + '从未登场的甲也出现了。';
  const inv = checkNoInvention({ compressed: withGhost, mustNotMention: c.absentChars.map((x) => x.name) });
  ok('摘要里冒出未出场角色 → 被抓住', inv.ok === false && inv.invented.includes('从未登场的甲'),
    JSON.stringify(inv.invented));
  const inv2 = checkNoInvention({ compressed: good, mustNotMention: c.absentChars.map((x) => x.name) });
  ok('没冒出来时不误报', inv2.ok === true, JSON.stringify(inv2.reasons));
  ok('空压缩结果不算"无中生有"（那一侧由完整性检查负责）',
    checkNoInvention({ compressed: '', mustNotMention: ['甲'] }).ok === true);
}

console.log('\n【9. 接线：两侧判据都接上了，且喂给模型的只有出场角色】');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync('server.js', 'utf8');
  ok('导入了分侧与无中生有检查',
    /partitionByAppearance/.test(src) && /checkNoInvention/.test(src));
  const i = src.indexOf('async function compressStoryMemory(');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  ok('按出场情况分侧', /partitionByAppearance\(\{ characters, worldEntries: worlds, chapterText \}\)/.test(body));
  ok('提示词里**只喂出场过的角色**（否则等于一边告知一边罚它写）',
    /characters\.filter\(\(c\) => appearedNames\.has\(c\.name\)\)/.test(body));
  ok('提示词里明确写了"不要引入未在此列的角色"', /不要引入任何未在此列的角色/.test(body));
  ok('完整性只核对出场侧', /mustKeep: mustKeepEntities\(\{ characters: cast\.appearedChars, worldEntries: cast\.appearedWorlds \}\)/.test(body));
  ok('无中生有核对未出场侧', /mustNotMention: cast\.absentChars\.map\(\(c\) => c\.name\)/.test(body));
  ok('两侧任一不过都拒绝落库', /if \(!guard\.ok \|\| !invention\.ok\)/.test(body));
  ok('落库仍在两次检查之后', body.indexOf('saveStoryMemory(') > body.indexOf('checkNoInvention('));
}

console.log(`\n══════════════════════════════`);
console.log(`记忆压缩零损失护栏离线测试：通过 ${pass} / 失败 ${fails.length}`);
for (const f of fails) console.log(`  · ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
process.exitCode = fails.length ? 1 : 0;
