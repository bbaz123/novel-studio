/**
 * tests/nsdsh/model-routing.test.mjs —— S10：按「作品 + 用途」路由（修 F04）。
 *
 * F04 的病灶：`SELECT … WHERE api_key <> '' ORDER BY id ASC LIMIT 1` ——
 * **第一个有 key 的配置就是答案**。本套件钉住：
 *   ① 作品级路由优先于全局；② 没有路由就 **NO_ROUTE**，绝不隐式挑一条；
 *   ③ 本地（回环）provider 不需要 key；外网 provider 没 key 必须被判 CONFIG_NO_KEY；
 *   ④ 用途必须是白名单里的，随手写的字符串不能当路由键。
 */
import assert from 'node:assert/strict';
import { isolatedDir, suite } from '../temporal/harness.mjs';

isolatedDir('nsdsh-model-routing-');
const { db } = await import('../../db.js');
const R = await import('../../ai/model-broker/routing.mjs');

let seq = 0;
function addConfig({ name = 'cfg', baseUrl = 'https://api.example.com', apiKey = 'sk-x', model = 'm1' } = {}) {
  seq += 1;
  const now = new Date().toISOString();
  const info = db.prepare(
    'INSERT INTO api_configs (name, base_url, api_key, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(`${name}-${seq}`, baseUrl, apiKey, model, now, now);
  return Number(info.lastInsertRowid);
}
function addWork(title = 'routing') {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO works (title, created_at, updated_at) VALUES (?, ?, ?)').run(`${title}-${seq}`, now, now);
  return Number(db.prepare('SELECT id FROM works ORDER BY id DESC LIMIT 1').get().id);
}

suite('nsdsh/model-routing', [
  ['S10-R1 有多个可用配置但没有路由 → AMBIGUOUS_NO_ROUTE（不再"第一个有 key 的配置就是答案"）', () => {
    // 造两个"有 key"的配置：旧实现会直接返回第一个
    const c1 = addConfig({ apiKey: 'sk-first' });
    const c2 = addConfig({ apiKey: 'sk-second' });
    const c3 = addConfig({ apiKey: 'sk-third' });
    assert.ok(c1 && c2 && c3);
    const r = R.resolveRoute(db, { workId: 0, purpose: 'analysis' });
    assert.equal(r.ok, false, '有多个候选却没路由时必须失败');
    assert.equal(r.reason, 'AMBIGUOUS_NO_ROUTE', `实际 ${r.reason}`);
    assert.equal(r.config, null, '不得回退到"第一个有 key 的配置"');
    assert.match(r.detail, /拒绝按插入顺序隐式挑选/, '错误信息要说明这是刻意的');
    // 有 0 个可用配置 → NO_ROUTE（与"多候选"区分开）
    const emptyDb = { prepare: () => ({ all: () => [], get: () => undefined }) };
    const none = R.resolveRoute(emptyDb, { workId: 0, purpose: 'analysis' });
    assert.equal(none.ok, false);
    assert.equal(none.reason, 'NO_ROUTE');
  }],

  ['S10-R1b 全库只有一个可用配置 → 直接用（不存在"选择"，但也不是按 id 挑）', () => {
    // 独立库：清掉路由与多余配置，只留一个
    db.prepare('DELETE FROM model_routes').run();
    db.prepare('DELETE FROM api_configs').run();
    db.prepare('DROP TABLE IF EXISTS __probe_dummy').run?.();
    const only = addConfig({ apiKey: 'sk-only', model: 'sole-model' });
    const r = R.resolveRoute(db, { workId: 0, purpose: 'analysis' });
    assert.equal(r.ok, true, '唯一配置时应当可用（否则单配置安装全废）');
    assert.equal(r.config.id, only);
    assert.equal(r.route.source, 'sole-config', '必须与"work/global 路由"区分开，便于诊断');
    assert.match(String(r.detail || ''), /不存在可选项/, '要说明这是无歧义，而不是隐式挑选');
  }],

  ['S10-R2 作品级路由优先于全局路由', () => {
    const w = addWork();
    const globalCfg = addConfig({ name: 'global' });
    const workCfg = addConfig({ name: 'work-specific' });
    R.setRoute(db, { workId: 0, purpose: 'analysis', apiConfigId: globalCfg });
    R.setRoute(db, { workId: w, purpose: 'analysis', apiConfigId: workCfg });

    const r = R.resolveRoute(db, { workId: w, purpose: 'analysis' });
    assert.equal(r.ok, true);
    assert.equal(r.config.id, workCfg, '作品级必须优先');
    assert.equal(r.route.source, 'work');

    // 另一个没有作品级路由的书 → 落到全局
    const w2 = addWork('other');
    const r2 = R.resolveRoute(db, { workId: w2, purpose: 'analysis' });
    assert.equal(r2.ok, true);
    assert.equal(r2.config.id, globalCfg, '没有作品级路由时用全局默认');
    assert.equal(r2.route.source, 'global');
  }],

  ['S10-R3 用途必须白名单：随手写的 purpose 不得当路由键', () => {
    for (const bad of ['', null, undefined, 'whatever', 'ANALYSIS-2', ' analysis ']) {
      try {
        R.normalizePurpose(bad);
        // 只有 ' analysis ' 会因为 trim 合法；其余必须抛
        assert.equal(String(bad).trim().toLowerCase(), 'analysis', `${JSON.stringify(bad)} 不应通过`);
      } catch (e) {
        assert.match(String(e.message), /MISSING_PURPOSE|UNKNOWN_PURPOSE/);
      }
    }
    assert.equal(R.normalizePurpose(' analysis '), 'analysis', '允许首尾空白但会归一化');
    // 未登记的 purpose 在 resolveRoute 里也要失败（而不是抛到调用方）
    const r = R.resolveRoute(db, { workId: 0, purpose: 'bogus' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /UNKNOWN_PURPOSE/);
  }],

  ['S10-R4 本地回环 provider 不需要 key；外网没 key 必须 CONFIG_NO_KEY', () => {
    assert.equal(R.isLocalProvider('http://127.0.0.1:3737/v1'), true);
    assert.equal(R.isLocalProvider('http://localhost:8080'), true);
    assert.equal(R.isLocalProvider('https://api.deepseek.com'), false);
    assert.equal(R.isLocalProvider(''), false);
    // 伪造形态：回环但伪装成外网（不应被判本地）
    assert.equal(R.isLocalProvider('https://127.0.0.1.evil.com/v1'), false, '前缀匹配不得把 evil 域名当本地');

    const localCfg = addConfig({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: '' });
    R.setRoute(db, { workId: 0, purpose: 'writing', apiConfigId: localCfg });
    const local = R.resolveRoute(db, { workId: 0, purpose: 'writing' });
    assert.equal(local.ok, true, '本地无 key provider 应当可用');
    assert.equal(local.needs_api_key, false);

    const remoteCfg = addConfig({ baseUrl: 'https://api.example.com', apiKey: '' });
    R.setRoute(db, { workId: 0, purpose: 'review', apiConfigId: remoteCfg });
    const remote = R.resolveRoute(db, { workId: 0, purpose: 'review' });
    assert.equal(remote.ok, false);
    assert.equal(remote.reason, 'CONFIG_NO_KEY', '外网地址没 key 必须失败，不能"试一下"');
  }],

  ['S10-R5 路由指向不存在的配置 → CONFIG_MISSING（不是静默换一个）', () => {
    const w = addWork('missing-cfg');
    // 直接写表绕过 setRoute 的存在性校验，模拟"配置被删了但路由还在"
    db.prepare('INSERT INTO model_routes (work_id, purpose, api_config_id) VALUES (?, ?, ?)').run(w, 'analysis', 999999);
    const r = R.resolveRoute(db, { workId: w, purpose: 'analysis' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'CONFIG_MISSING');
  }],

  ['S10-R6 setRoute 拒绝不存在的配置；listRoutes 能看到写过的路由', () => {
    const w = addWork('setter');
    assert.throws(() => R.setRoute(db, { workId: w, purpose: 'analysis', apiConfigId: 888888 }), /API_CONFIG_NOT_FOUND/);
    assert.throws(() => R.setRoute(db, { workId: w, purpose: 'analysis', apiConfigId: 0 }), /MISSING_API_CONFIG_ID/);
    const cfg = addConfig({ name: 'listed' });
    R.setRoute(db, { workId: w, purpose: 'compress', apiConfigId: cfg, note: '记忆压缩用便宜模型' });
    const rows = R.listRoutes(db).filter((x) => x.work_id === w);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].purpose, 'compress');
    assert.equal(rows[0].api_config_id, cfg);
    // 同一 (work, purpose) 再写就是覆盖（唯一索引）
    const cfg2 = addConfig({ name: 'replaced' });
    R.setRoute(db, { workId: w, purpose: 'compress', apiConfigId: cfg2 });
    const rows2 = R.listRoutes(db).filter((x) => x.work_id === w);
    assert.equal(rows2.length, 1, '同一作品同一用途只能有一条路由');
    assert.equal(rows2[0].api_config_id, cfg2);
  }],

  ['S10-R7 不同用途可以指向不同模型（同作品互不干扰）', () => {
    const w = addWork('multi-purpose');
    const cheap = addConfig({ name: 'cheap', model: 'fast' });
    const strong = addConfig({ name: 'strong', model: 'pro' });
    R.setRoute(db, { workId: w, purpose: 'analysis', apiConfigId: cheap });
    R.setRoute(db, { workId: w, purpose: 'writing', apiConfigId: strong });
    const a = R.resolveRoute(db, { workId: w, purpose: 'analysis' });
    const b = R.resolveRoute(db, { workId: w, purpose: 'writing' });
    assert.equal(a.config.model, 'fast');
    assert.equal(b.config.model, 'pro');
    assert.notEqual(a.config.id, b.config.id);
  }],
]);
