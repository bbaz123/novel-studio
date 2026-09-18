// 离线验证：工具配置的解析链（OpenViking 凭证 / dsh 仓库）+ 全局配置写入。
// 不连服务器、不产生任何 AI 调用、不碰真实的 ~/.openviking 与 ~/.dsh。
//
// 为什么单独一个文件、而不是塞进 api-test-suite：
//   1) 「一键写入全局 ovcli.conf」会改作者主目录下的文件。api-test-suite 是**对着一个
//      实例**跑的套件，可能被人指向非隔离实例（甚至 3737 主实例）——在那里调这个接口
//      就是动用户的真实配置。这里用 OPENVIKING_CLI_CONFIG_FILE 指到临时目录，零污染。
//   2) 解析链的输入是「环境变量 + 磁盘配置文件」，是纯函数，用临时目录就能把真值表钉死，
//      不必依赖任何服务状态。
//
// 运行：node env-tools-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 必须在 import openviking.js **之前**设置：logger.js 在模块加载时就解析数据目录，
// 晚一步就会指到仓库的 data/（真实数据目录）。
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-env-tools-'));
process.env.NOVELSTUDIO_DATA_DIR = path.join(SANDBOX, 'data');
process.env.NOVELSTUDIO_OV_DISABLED = '1';

const {
  resolveOpenVikingConfig,
  writeGlobalOpenVikingConfig,
  openVikingConfigInfo,
  setOpenVikingWorkshopConfig,
  getOpenVikingWorkshopConfig
} = await import('./openviking.js');

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures += 1;
}

// 断言助手自检（记在 OpenViking 的第 8 条纪律：助手签名写错会让条件恒判通过，
// 而输出里只会多出一个突兀的 true，肉眼很难发现）。喂一个假条件，确认它真的计入失败。
{
  const before = failures;
  const realLog = console.log;
  console.log = () => {};
  check('__selfcheck__', false);
  console.log = realLog;
  const caught = failures === before + 1;
  failures = before;
  check('S0 断言助手自检：假条件会被计入失败', caught);
}

// ---------- 临时配置文件与工具 ----------
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
const caseDir = (name) => {
  const dir = path.join(SANDBOX, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
/** 一组互不干扰的 env：把两个配置文件指到本用例的临时目录，并清掉进程里可能存在的 OPENVIKING_*。 */
function envFor(dir, extra = {}) {
  return {
    OPENVIKING_CLI_CONFIG_FILE: path.join(dir, 'ovcli.conf'),
    OPENVIKING_CONFIG_FILE: path.join(dir, 'ov.conf'),
    ...extra
  };
}

// ---------- A. 凭证解析链的优先级真值表 ----------
// 阶梯：OPENVIKING_* 环境变量 > 工坊内设置 > ovcli.conf > ov.conf(server) > 默认
console.log('\n== A. OpenViking 凭证解析链 ==');
{
  // A1 什么都没有 → 默认本机 1933，且**来源要如实标成 default**
  const d1 = caseDir('a1');
  const c1 = resolveOpenVikingConfig(envFor(d1), {});
  check('A1 无任何配置时回落到默认地址', c1.endpoint === 'http://127.0.0.1:1933' && c1.endpointSource === 'default', `${c1.endpoint} / ${c1.endpointSource}`);
  check('A2 无配置时 Key 来源为 none 且值为空', c1.apiKey === '' && c1.apiKeySource === 'none', c1.apiKeySource);

  // A3 ov.conf 的 server.port 生效
  const d2 = caseDir('a2');
  writeJson(path.join(d2, 'ov.conf'), { server: { host: '127.0.0.1', port: 1999, root_api_key: 'key-from-conf' } });
  const c2 = resolveOpenVikingConfig(envFor(d2), {});
  check('A3 ov.conf 的 host/port 生效', c2.endpoint === 'http://127.0.0.1:1999' && c2.endpointSource === 'conf', `${c2.endpoint} / ${c2.endpointSource}`);
  check('A4 ov.conf 的 root_api_key 被采用', c2.apiKey === 'key-from-conf' && c2.apiKeySource === 'conf', c2.apiKeySource);

  // A5 ovcli.conf 覆盖 ov.conf
  const d3 = caseDir('a3');
  writeJson(path.join(d3, 'ov.conf'), { server: { port: 1999, root_api_key: 'key-from-conf' } });
  writeJson(path.join(d3, 'ovcli.conf'), { url: 'http://127.0.0.1:1888', api_key: 'key-from-cli' });
  const c3 = resolveOpenVikingConfig(envFor(d3), {});
  check('A5 ovcli.conf 覆盖 ov.conf', c3.endpoint === 'http://127.0.0.1:1888' && c3.endpointSource === 'cli', `${c3.endpoint} / ${c3.endpointSource}`);
  check('A6 ovcli.conf 的 api_key 覆盖 root_api_key', c3.apiKey === 'key-from-cli' && c3.apiKeySource === 'cli', c3.apiKeySource);

  // A7 工坊内设置覆盖两个配置文件（这就是 AI 设置页保存的那一层）
  const c4 = resolveOpenVikingConfig(envFor(d3), { endpoint: 'http://127.0.0.1:1777', apiKey: 'key-from-workshop' });
  check('A7 工坊内设置覆盖配置文件', c4.endpoint === 'http://127.0.0.1:1777' && c4.endpointSource === 'workshop', `${c4.endpoint} / ${c4.endpointSource}`);
  check('A8 工坊内设置的 Key 生效', c4.apiKey === 'key-from-workshop' && c4.apiKeySource === 'workshop', c4.apiKeySource);

  // A9 环境变量仍然最高优先（工坊不该悄悄压过作者显式设的环境变量）
  const c5 = resolveOpenVikingConfig(envFor(d3, { OPENVIKING_URL: 'http://10.0.0.5:1234/', OPENVIKING_API_KEY: 'key-from-env' }), { endpoint: 'http://127.0.0.1:1777', apiKey: 'key-from-workshop' });
  check('A9 环境变量优先于工坊内设置', c5.endpoint === 'http://10.0.0.5:1234' && c5.endpointSource === 'env', `${c5.endpoint} / ${c5.endpointSource}`);
  check('A10 环境变量的 Key 优先于工坊内设置', c5.apiKey === 'key-from-env' && c5.apiKeySource === 'env', c5.apiKeySource);
  check('A11 尾部斜杠被剥掉（避免拼出 //api/...）', c5.endpoint === 'http://10.0.0.5:1234');

  // A12 模块级注入路径（server.js 走的就是这条）：setter 与 getter 语义一致
  setOpenVikingWorkshopConfig({ endpoint: 'http://127.0.0.1:1666', apiKey: 'k' });
  const injected = getOpenVikingWorkshopConfig();
  check('A12 setOpenVikingWorkshopConfig 是进程内生效的注入点', injected.endpoint === 'http://127.0.0.1:1666' && injected.apiKey === 'k', JSON.stringify(injected));
  const c6 = resolveOpenVikingConfig(envFor(d3));
  check('A13 不传第二参时用模块级注入值', c6.endpointSource === 'workshop' && c6.endpoint === 'http://127.0.0.1:1666', `${c6.endpoint} / ${c6.endpointSource}`);
  setOpenVikingWorkshopConfig({ endpoint: '', apiKey: '' });
  const c7 = resolveOpenVikingConfig(envFor(d3));
  check('A14 注入空值 = 回到下层（可撤销）', c7.endpointSource === 'cli' && c7.endpoint === 'http://127.0.0.1:1888', `${c7.endpoint} / ${c7.endpointSource}`);

  // A15~A18：与插件凭证链的两处差异（2026-09-18 第四轮重审拿插件源码比对后补齐）。
  // 这两条都属于"工坊与 dsh 侧读的不是同一份配置"，而症状是**召回不到**——
  // 最难归因的一类：界面显示已连接，AI 写作却拿不到记忆。
  const homeProbe = openVikingConfigInfo({ OPENVIKING_CLI_CONFIG_FILE: '~/ns-probe-dir/ovcli.conf' }).config_paths.cli;
  check('A15 `~` 形式的路径被展开（否则与插件读的不是同一个文件）',
    homeProbe === path.join(os.homedir(), 'ns-probe-dir', 'ovcli.conf'), homeProbe);
  const relProbe = openVikingConfigInfo({ OPENVIKING_CLI_CONFIG_FILE: 'rel-probe/ovcli.conf' }).config_paths.cli;
  check('A16 相对路径解析成绝对路径（否则会随启动目录漂移）',
    path.isAbsolute(relProbe) && relProbe.endsWith(path.join('rel-probe', 'ovcli.conf')), relProbe);
  const d4 = caseDir('a4');
  writeJson(path.join(d4, 'ovcli.conf'), { url: 'http://127.0.0.1:1888', api_key: 'key-from-cli' });
  const cCli = resolveOpenVikingConfig(
    envFor(d4, { OPENVIKING_CREDENTIAL_SOURCE: 'cli', OPENVIKING_URL: 'http://10.0.0.9:1', OPENVIKING_API_KEY: 'key-from-env' }),
    { endpoint: 'http://127.0.0.1:1777', apiKey: 'key-from-workshop' });
  check('A17 CREDENTIAL_SOURCE=cli 时忽略环境变量与工坊设置（与插件同语义）',
    cCli.endpointSource === 'cli' && cCli.endpoint === 'http://127.0.0.1:1888' && cCli.apiKeySource === 'cli',
    `${cCli.endpoint} / ${cCli.endpointSource}`);
  const cEnv = resolveOpenVikingConfig(
    envFor(d4, { OPENVIKING_CREDENTIAL_SOURCE: 'env', OPENVIKING_URL: 'http://10.0.0.9:1' }),
    { endpoint: 'http://127.0.0.1:1777' });
  check('A18 CREDENTIAL_SOURCE=env 时忽略配置文件',
    cEnv.endpointSource === 'env' && cEnv.endpoint === 'http://10.0.0.9:1', `${cEnv.endpoint} / ${cEnv.endpointSource}`);
}

// ---------- B. 配置信息不外泄密钥 ----------
console.log('\n== B. 对外展示的配置信息不含明文密钥 ==');
{
  const d = caseDir('b1');
  writeJson(path.join(d, 'ovcli.conf'), { url: 'http://127.0.0.1:1888', api_key: 'sk-super-secret-value', actor_peer_id: 'peer-x' });
  const info = openVikingConfigInfo(envFor(d));
  const dumped = JSON.stringify(info);
  check('B1 信息对象含来源标签与是否已配置', info.endpoint_source === 'cli' && info.has_api_key === true && info.endpoint_source_label.length > 0, JSON.stringify({ source: info.endpoint_source, has: info.has_api_key }));
  check('B2 信息对象里没有明文 Key', !dumped.includes('sk-super-secret-value'), dumped.slice(0, 120));
  check('B3 信息对象不含 apiKey 字段（只给 has_api_key）', !('apiKey' in info) && !('api_key' in info));
}

// ---------- C. 一键写入全局配置（全程只在临时目录里写） ----------
console.log('\n== C. 写入全局 ovcli.conf（含备份与拒绝策略） ==');
{
  // C1 文件不存在 → 创建；没有备份可留
  const d1 = caseDir('c1');
  const cli1 = path.join(d1, 'ovcli.conf');
  const r1 = writeGlobalOpenVikingConfig({ endpoint: 'http://127.0.0.1:1933', apiKey: 'k1' }, envFor(d1));
  check('C1 目标文件不存在时创建成功', r1.ok === true && fs.existsSync(cli1), r1.error || '');
  check('C2 改动字段如实回报', JSON.stringify(r1.changed) === JSON.stringify(['url', 'api_key']), JSON.stringify(r1.changed));
  check('C3 新建时说明"原先不存在"的还原方式', r1.backup === '' && /不存在/.test(r1.restore_hint || '') && String(r1.restore_hint).includes(cli1), r1.restore_hint);

  // C4 既有文件：其它字段必须原样保留（account / peer / user 等不是我们管的）
  const d2 = caseDir('c2');
  const cli2 = path.join(d2, 'ovcli.conf');
  writeJson(cli2, { url: 'http://old:1', api_key: 'oldkey', actor_peer_id: 'peer-keep', account: 'acc-keep', user: 'user-keep' });
  const beforeText = fs.readFileSync(cli2, 'utf8');
  const r2 = writeGlobalOpenVikingConfig({ endpoint: 'http://new:2', apiKey: 'newkey' }, envFor(d2));
  const after = readJson(cli2);
  check('C4 写入成功且只改 url/api_key', r2.ok === true && after.url === 'http://new:2' && after.api_key === 'newkey', JSON.stringify(after));
  check('C5 其它字段原样保留', after.actor_peer_id === 'peer-keep' && after.account === 'acc-keep' && after.user === 'user-keep', JSON.stringify(after));
  check('C6 生成备份且内容等于原文件', Boolean(r2.backup) && fs.existsSync(r2.backup) && fs.readFileSync(r2.backup, 'utf8') === beforeText, r2.backup);
  check('C7 还原说明里带出备份路径', String(r2.restore_hint || '').includes(r2.backup), r2.restore_hint);

  // C8 已经是同一份凭证 → 不写、不产生多余备份
  const backupsBefore = fs.readdirSync(d2).filter((f) => f.includes('.bak-')).length;
  const r3 = writeGlobalOpenVikingConfig({ endpoint: 'http://new:2', apiKey: 'newkey' }, envFor(d2));
  const backupsAfter = fs.readdirSync(d2).filter((f) => f.includes('.bak-')).length;
  check('C8 值相同则不改动也不新增备份', r3.ok === true && r3.changed.length === 0 && backupsAfter === backupsBefore, `changed=${JSON.stringify(r3.changed)}`);

  // C9 关键安全断言：文件存在但不是合法 JSON → 拒绝写入，且**文件一个字节都不能变**
  const d3 = caseDir('c3');
  const cli3 = path.join(d3, 'ovcli.conf');
  const broken = '{ 这不是 JSON，是作者手改坏了的内容 ';
  fs.writeFileSync(cli3, broken, 'utf8');
  const r4 = writeGlobalOpenVikingConfig({ endpoint: 'http://new:3', apiKey: 'k' }, envFor(d3));
  check('C9 非法 JSON 被拒绝且文件未被覆盖', r4.ok === false && fs.readFileSync(cli3, 'utf8') === broken, r4.error || '');
  check('C10 拒绝原因里点名具体文件', String(r4.error || '').includes(cli3), r4.error);

  // C11 顶层是数组（合法 JSON 但不是配置对象）→ 同样拒绝
  const d4 = caseDir('c4');
  const cli4 = path.join(d4, 'ovcli.conf');
  fs.writeFileSync(cli4, '[]', 'utf8');
  const r5 = writeGlobalOpenVikingConfig({ endpoint: 'http://new:4' }, envFor(d4));
  check('C11 顶层非对象被拒绝', r5.ok === false && fs.readFileSync(cli4, 'utf8') === '[]', r5.error || '');

  // C12 空值不构成改动（避免把空串写进配置、把作者的凭证抹掉）
  const d5 = caseDir('c5');
  const cli5 = path.join(d5, 'ovcli.conf');
  writeJson(cli5, { url: 'http://keep:1', api_key: 'keepkey' });
  const r6 = writeGlobalOpenVikingConfig({ endpoint: '   ', apiKey: '' }, envFor(d5));
  const after5 = readJson(cli5);
  check('C12 空值不会抹掉既有凭证', r6.ok === true && r6.changed.length === 0 && after5.api_key === 'keepkey' && after5.url === 'http://keep:1', JSON.stringify(after5));

  // C13 写回的是无 BOM 的 UTF-8（Windows 上的老坑：带 BOM 会让 JSON.parse 失败）
  const d6 = caseDir('c6');
  const cli6 = path.join(d6, 'ovcli.conf');
  writeGlobalOpenVikingConfig({ endpoint: 'http://bom:1', apiKey: 'k' }, envFor(d6));
  const bytes = fs.readFileSync(cli6);
  check('C13 写出的文件不带 BOM', !(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF), `first=${bytes[0]}`);
  check('C14 写出的文件可被 JSON.parse 读回（自描述往返）', (() => { try { return JSON.parse(bytes.toString('utf8')).url === 'http://bom:1'; } catch { return false; } })());
}

// ---------- 收尾 ----------
try {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
} catch { /* 清理失败不影响结论 */ }

console.log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} ===`);
process.exit(failures ? 1 : 0);
