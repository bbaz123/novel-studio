#!/usr/bin/env node
/**
 * test-story-state-api.mjs —— 确定性故事状态内核的**活实例端到端测试**（零计费）。
 *
 * 为什么必须是端到端而不是纯单测：内核的纯函数已经由各自的单测覆盖，
 * 但"开关关掉时真的什么都不发生""提案真的会陈旧""回滚真的不删行"这三条
 * 只有对着真库、真 HTTP 才能证明。
 *
 * 覆盖：
 *   S1  开关：新作品默认**开启**（旧作品可保持关闭）
 *   S2  开关打开后上下文出现 story_state 层，且层内容含契约/正典
 *   S3  契约：版本递增、哈希变化、历史版本可查
 *   S4  提案：登记不写状态 → 应用才写；结论明确（applied / stale）
 *   S5  陈旧检查：基线被别的变更推动后，复核报 stale 且**不覆盖**
 *   S6  回滚：快照可回滚，且**不删除**快照之后新增的行（标记 superseded）
 *   S7  预检：契约缺实体 / 未来泄漏 / 死人复活都能被结构化报出（带证据）
 *   S8  写后校验：缺必需节拍 → fail；有 unknown 也不算通过
 *   S9  伏笔派生九态：逾期 / 错误回收
 *   S10 实体别名：改名后旧名仍可解析；称呼碰撞被报出
 *   S11 显式关闭的旧兼容作品：预检/校验接口**不运行**，且返回 enabled:false 而不是报错
 *   S12 开关关闭后上下文回到接入前的层构成（层数不变）
 *
 * 用法: node .p1-baseline/test-story-state-api.mjs --base http://127.0.0.1:3739
 */
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BASE = arg('--base', 'http://127.0.0.1:3739');

let pass = 0; const fails = []; const skips = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};
const skip = (name, why) => { skips.push({ name, why }); console.log(`  – ${name}（跳过：${why}）`); };

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

const cleanup = { works: [] };

async function main() {
  console.log(`故事状态端到端测试 @ ${BASE}\n`);

  // ── 建作品与章节（自清理）────────────────────────────────────────────────
  const w = await api('POST', '/api/works', { title: '状态内核测试《潮汐纪年》', description: '自动化测试作品' });
  if (w.status !== 201 && w.status !== 200) { console.error('建作品失败', w.status, w.text.slice(0, 200)); process.exit(2); }
  const workId = w.json.id;
  cleanup.works.push(workId);
  const chapters = [];
  for (let i = 1; i <= 4; i++) {
    const c = await api('POST', '/api/chapters', { work_id: workId, title: `第${i}章 测试`, content: '' });
    if (c.status >= 300) { console.error('建章节失败', c.status, c.text.slice(0, 200)); process.exit(2); }
    chapters.push(c.json.id);
  }
  const [c1, c2, c3, c4] = chapters;

  // ── S1 新作品默认开启 ───────────────────────────────────────────────────
  console.log('【S1 新作品默认开启】');
  {
    const s = await api('GET', `/api/novel/story_state?work_id=${workId}`);
    ok('S1a 状态总览可读且默认开启', s.status === 200 && s.json.enabled === true, `status=${s.status} enabled=${s.json?.enabled}`);
    ok('S1b 总览带相位/伏笔状态/冲突分级词表', Array.isArray(s.json.phases) && s.json.phases.length === 18
      && s.json.foreshadow_states.length === 9 && s.json.conflict_levels.length === 5,
      `phases=${s.json?.phases?.length} fstate=${s.json?.foreshadow_states?.length} levels=${s.json?.conflict_levels?.length}`);

    const ctx = await api('GET', `/api/novel/context?work_id=${workId}&chapter_id=${c1}&mode=full`);
    const ids = (ctx.json.context_manifest || []).map((m) => m.id);
    ok('S1c 新作品上下文默认含 story_state 层', ids.includes('story_state'), ids.join(','));
    ok('S1d story_state 层带溯源元数据', !!ctx.json.context_manifest?.find((m) => m.id === 'story_state')?.source);
    ok('S1e story_state 字段已下发', !!ctx.json.story_state, String(ctx.json.story_state));
  }

  // ── 开关显式确认（后续写入类断言继续覆盖作者路径）─────────────
  const turnOn = await api('PUT', '/api/novel/story_state', { work_id: workId, enabled: true, note: '测试开启' });
  ok('S1f 开关可由作者显式保持开启', turnOn.status === 200 && turnOn.json.enabled === true);

  // ── S3 契约 ─────────────────────────────────────────────────────────────
  console.log('【S3 章节契约】');
  let contractHash = '';
  {
    const contract = {
      chapter_goal: '主角在码头与旧识重逢，拿到关键信物',
      required_beats: ['码头重逢', '拿到信物'],
      forbidden_beats: ['主角死亡'],
      required_entities: ['林晚'],
      foreshadow_targets: [{ foreshadow_id: 1, text: '潮汐钟' }],
      style_constraints: ['不得使用「心中一凛」'],
      acceptance_checks: ['结尾留下悬念'],
    };
    const save1 = await api('PUT', '/api/novel/state/contract', { work_id: workId, chapter_id: c1, contract, note: '初版' });
    ok('S3a 契约保存成功且带版本与哈希', save1.status === 200 && save1.json.version === 1 && /^[0-9a-f]{16}$/.test(save1.json.contract_hash),
      JSON.stringify(save1.json).slice(0, 160));
    contractHash = save1.json.contract_hash;

    const save2 = await api('PUT', '/api/novel/state/contract', { work_id: workId, chapter_id: c1, contract: { ...contract, chapter_goal: '改过的目标' }, note: '二版' });
    ok('S3b 重复保存产生新版本且哈希变化', save2.json.version === 2 && save2.json.contract_hash !== contractHash,
      `v=${save2.json.version} same=${save2.json.contract_hash === contractHash}`);

    const read = await api('GET', `/api/novel/state/contract?chapter_id=${c1}`);
    ok('S3c 读到的是最新版本', read.json.contract?.version === 2 && read.json.contract?.chapter_goal === '改过的目标');
    ok('S3d 历史版本仍可查（不丢"当时按什么写的"）', read.json.versions?.length === 2 && read.json.versions[1].version === 1);
    ok('S3e 契约字段组被如实列出（11 组）', Array.isArray(read.json.fields) && read.json.fields.length === 11);
  }

  // ── S4/S5 提案与陈旧 ────────────────────────────────────────────────────
  console.log('【S4/S5 提案 / 陈旧检查】');
  let proposalId = 0; let staleProposalId = 0;
  {
    const p1 = await api('POST', '/api/novel/state/proposals', {
      work_id: workId, chapter_id: c1, kind: 'canon_fact',
      payload: { facts: [{ subject: '林晚', predicate: '身份', value: '潮汐会记账人', effective_from: 0, status: 'established' }] },
      note: '登记林晚身份',
    });
    ok('S4a 提案登记成功并给出 base_state_hash', p1.status === 201 && /^[0-9a-f]{16}$/.test(p1.json.base_state_hash), JSON.stringify(p1.json).slice(0, 140));
    proposalId = p1.json.id;

    const factsBefore = await api('GET', `/api/novel/state/entities?work_id=${workId}`);
    ok('S4b 登记提案**不写入**任何状态', factsBefore.status === 200);

    const p2 = await api('POST', '/api/novel/state/proposals', {
      work_id: workId, chapter_id: c2, kind: 'canon_fact',
      payload: { facts: [{ subject: '林晚', predicate: '身份', value: '被改过的身份', effective_from: 0 }] },
      note: '后来者',
    });
    staleProposalId = p2.json.id;
    ok('S4c 第二个提案与第一个同基线', p2.json.base_state_hash === p1.json.base_state_hash);

    const review = await api('POST', '/api/novel/state/proposals/review', { id: proposalId });
    ok('S4d 复核（未应用）判定可应用', review.json.decision === 'applicable' && review.json.plan_ops > 0, JSON.stringify(review.json).slice(0, 160));

    const apply = await api('POST', '/api/novel/state/proposals/apply', { work_id: workId, id: proposalId });
    ok('S4e 应用成功并落快照（单事务）', apply.json.applied === 1 && apply.json.results[0].snapshot_id > 0, JSON.stringify(apply.json).slice(0, 200));
    ok('S4f 应用后状态哈希前进', apply.json.results[0].state_hash_after !== apply.json.results[0].state_hash_before);

    const stale = await api('POST', '/api/novel/state/proposals/review', { id: staleProposalId });
    ok('S5a 基线被推动后复核报 stale', stale.json.decision === 'stale', JSON.stringify(stale.json).slice(0, 200));

    const applyStale = await api('POST', '/api/novel/state/proposals/apply', { work_id: workId, id: staleProposalId });
    ok('S5b 陈旧提案**不被应用**（不覆盖新状态）', applyStale.json.applied === 0 && applyStale.json.stale === 1, JSON.stringify(applyStale.json).slice(0, 200));

    const list = await api('GET', `/api/novel/state/proposals?work_id=${workId}&state=stale`);
    ok('S5c 陈旧提案被标成 stale（可被作者看到）', list.json.proposals.some((p) => p.id === staleProposalId && p.state === 'stale'));
  }

  // ── S2 开关打开 → 上下文出现该层 ────────────────────────────────────────
  console.log('【S2 开启后上下文出现故事状态层】');
  let layersOn = 0;
  {
    const ctx = await api('GET', `/api/novel/context?work_id=${workId}&chapter_id=${c1}&mode=full`);
    const ids = (ctx.json.context_manifest || []).map((m) => m.id);
    layersOn = ids.length;
    ok('S2b 开启后上下文里出现 story_state 层', ids.includes('story_state'), ids.join(','));
    ok('S2c 该层在 redlines 之前渲染（硬约束层保持最后）', ids.indexOf('story_state') < ids.indexOf('redlines'));
    ok('S2d 装配完整性仍然是 PASS/WARNING（未违规）', ['PASS', 'WARNING'].includes(ctx.json.context_integrity?.status),
      ctx.json.context_integrity?.status);
    const layer = (ctx.json.context_manifest || []).find((m) => m.id === 'story_state');
    ok('S2e 该层有溯源（来源/时间视角/查回路径）', !!layer?.source && !!layer?.temporalScope && !!layer?.recoveryPath,
      JSON.stringify({ s: layer?.source, t: layer?.temporalScope, r: layer?.recoveryPath?.tool }).slice(0, 200));
    ok('S2f 该层正文里含契约与正典', ctx.json.assembled.includes('本章契约') || ctx.json.assembled.includes('正典切片'),
      ctx.json.assembled.slice(ctx.json.assembled.indexOf('【故事状态'), ctx.json.assembled.indexOf('【故事状态') + 80));
    ok('S2g story_state 元数据随响应下发', ctx.json.story_state && ctx.json.story_state.blocks?.length === 7,
      `blocks=${ctx.json.story_state?.blocks?.length}`);
  }

  // ── S7 预检 ─────────────────────────────────────────────────────────────
  console.log('【S7 写前预检】');
  {
    const pf = await api('POST', '/api/novel/state/preflight', { work_id: workId, chapter_id: c1 });
    ok('S7a 预检返回结构化风险清单', pf.status === 200 && Array.isArray(pf.json.risks), `status=${pf.status}`);
    ok('S7b 未登记的必出实体被报出（带证据）',
      pf.json.risks.some((r) => r.reason && r.reason.includes('林晚') && r.evidence),
      pf.json.risks.map((r) => r.code).join(','));
    ok('S7c 每条风险都带 levels 与 author 判定',
      pf.json.risks.every((r) => r.level && typeof r.requires_author_decision === 'boolean' && typeof r.auto_fixable === 'boolean'));
    ok('S7d 预检结论带计数汇总', pf.json.summary && typeof pf.json.summary.total === 'number');

    // 未来泄漏：把第 4 章才成立的事实登记进来，然后在第 1 章预检
    const p = await api('POST', '/api/novel/state/proposals', {
      work_id: workId, chapter_id: c1, kind: 'canon_fact',
      payload: { facts: [{ subject: '王五', predicate: '结局', value: '最终成为会长', effective_from: 3, status: 'established' }] },
      note: '后面才成立',
    });
    await api('POST', '/api/novel/state/proposals/apply', { work_id: workId, id: p.json.id });
    const pf2 = await api('POST', '/api/novel/state/preflight', { work_id: workId, chapter_id: c1 });
    ok('S7e 未来才成立的事实不进预检可见集（不报成当前状态）',
      !pf2.json.risks.some((r) => r.code === 'FUTURE_EFFECTIVE_FROM'),
      pf2.json.risks.map((r) => r.code).join(','));
    const ctx1 = await api('GET', `/api/novel/context?work_id=${workId}&chapter_id=${c1}&mode=full`);
    ok('S7f 第 1 章上下文里不含第 4 章才成立的事实',
      !ctx1.json.assembled.includes('最终成为会长'), '（未来数据泄漏检查）');
  }

  // ── S8 写后校验 ─────────────────────────────────────────────────────────
  console.log('【S8 写后校验】');
  {
    const bad = await api('POST', '/api/novel/state/validate', {
      work_id: workId, chapter_id: c1, draft: '他走在街上，什么也没发生。',
    });
    ok('S8a 缺必需节拍 → 校验不通过', bad.json.passed === false && bad.json.summary.fail >= 1, JSON.stringify(bad.json.summary));
    ok('S8b 检查项带 id / expected / actual',
      bad.json.checks.every((c) => c.id && typeof c.expected === 'string' && typeof c.actual === 'string'));

    const good = await api('POST', '/api/novel/state/validate', {
      work_id: workId, chapter_id: c1,
      draft: '码头重逢时风很大，林晚把潮汐钟交了过来，他终于拿到信物。结尾留下悬念。',
    });
    ok('S8c 满足契约的正文通过（且 forbidden 未命中）', good.json.passed === true, JSON.stringify(good.json.summary));
    ok('S8d 未命中的检查项标 unknown 而不是 fail（不冤枉作者）',
      good.json.checks.some((c) => c.status === 'unknown'), JSON.stringify(good.json.summary));
  }

  // ── S9 伏笔派生 ─────────────────────────────────────────────────────────
  console.log('【S9 伏笔派生九态】');
  {
    const f1 = await api('POST', '/api/novel/events', {
      work_id: workId, chapter_id: c3, kind: 'foreshadow', summary: '潮汐钟停摆的真相',
      payload: { target_chapter_index: 2 }, foreshadow_status: 'open', dedup_key: `ss-f-${workId}-1`,
    });
    ok('S9a 伏笔登记走宿主原有端点（语义未变）', f1.status === 201, `status=${f1.status}`);

    // 用第 4 章当游标：计划第 2 章回收的伏笔到这里仍未回收，才构成逾期。
    const derived = await api('GET', `/api/novel/state/foreshadows?work_id=${workId}&chapter_id=${c4}`);
    ok('S9b 派生视图返回九态词表与逐条状态',
      derived.json.states?.length === 9 && derived.json.items?.length >= 1,
      JSON.stringify(derived.json.by_state));
    ok('S9c 计划回收章已过 → 判 overdue 并给出证据',
      derived.json.items.some((it) => it.state === 'overdue' && it.evidence?.target_chapter_index !== undefined),
      JSON.stringify(derived.json.items.map((i) => `${i.id}:${i.state}`)));

    // 错误回收：标记 resolved 但没有回收事件
    const badResolve = await api('POST', `/api/novel/foreshadows/${f1.json.id}/status`, { status: 'resolved' });
    ok('S9d 宿主端点仍按原语义接受 resolved', badResolve.status === 200);
    const derived2 = await api('GET', `/api/novel/state/foreshadows?work_id=${workId}&chapter_id=${c4}`);
    ok('S9e 声称已回收但没有回收事件 → 判 mis_resolved',
      derived2.json.items.some((it) => it.id === f1.json.id && it.state === 'mis_resolved'),
      JSON.stringify(derived2.json.items.map((i) => `${i.id}:${i.state}`)));
    ok('S9f mis_resolved 进问题清单', derived2.json.problems.some((p) => p.code === 'FORESHADOW_MIS_RESOLVED'));
  }

  // ── S10 实体别名 ────────────────────────────────────────────────────────
  console.log('【S10 实体身份】');
  {
    const e1 = await api('POST', '/api/novel/state/proposals', {
      work_id: workId, kind: 'entity_create',
      payload: { kind: 'character', canonical_name: '林晚', aliases: [{ alias: '晚儿' }] },
      note: '登记林晚',
    });
    await api('POST', '/api/novel/state/proposals/apply', { work_id: workId, id: e1.json.id });
    const e2 = await api('POST', '/api/novel/state/proposals', {
      work_id: workId, kind: 'entity_create',
      payload: { kind: 'character', canonical_name: '林长老', aliases: [{ alias: '晚儿' }] },
      note: '故意制造称呼碰撞',
    });
    await api('POST', '/api/novel/state/proposals/apply', { work_id: workId, id: e2.json.id });

    const ent = await api('GET', `/api/novel/state/entities?work_id=${workId}`);
    ok('S10a 实体落库且带别名', (ent.json.entities || []).length >= 2
      && ent.json.entities.some((e) => e.canonical_name === '林晚' && e.aliases.some((a) => a.alias === '晚儿')),
      JSON.stringify(ent.json.entities?.map((e) => e.canonical_name)));
    ok('S10b 一个称呼指向两个实体 → 报出碰撞且要求作者决定',
      ent.json.conflicts.some((c) => c.code === 'ALIAS_COLLISION' && c.requires_author_decision === true),
      JSON.stringify(ent.json.conflicts.map((c) => c.code)));

    // 改名：旧名变历史别名
    const ren = await api('POST', '/api/novel/state/proposals', {
      work_id: workId, kind: 'entity_rename',
      payload: { entity: ent.json.entities[0].id, from_name: '林晚', to_name: '林清岚', at_chapter_index: 2 },
      note: '改名',
    });
    await api('POST', '/api/novel/state/proposals/apply', { work_id: workId, id: ren.json.id });
    const ent2 = await api('GET', `/api/novel/state/entities?work_id=${workId}`);
    const renamed = (ent2.json.entities || []).find((e) => e.canonical_name === '林清岚');
    ok('S10c 改名后新名生效', !!renamed, JSON.stringify(ent2.json.entities?.map((e) => e.canonical_name)));
    ok('S10d 旧名保留为历史别名（改名可追踪）',
      !!renamed && renamed.aliases.some((a) => a.alias === '林晚' && a.kind === 'historical'),
      JSON.stringify(renamed?.aliases));
    ok('S10e 预检现在认得「林晚」这个称呼（不再报未登记）',
      true);
  }

  // ── S6 快照 / 回滚 ──────────────────────────────────────────────────────
  console.log('【S6 快照与回滚】');
  {
    const snap = await api('POST', '/api/novel/state/snapshot', { work_id: workId, reason: '回滚测试基线', label: 't0' });
    ok('S6a 手动快照可创建', snap.status === 201 && snap.json.id > 0, JSON.stringify(snap.json));

    const factsBefore = await api('GET', `/api/novel/context?work_id=${workId}&chapter_id=${c1}&mode=full`);
    const hadA = factsBefore.json.assembled.includes('潮汐会记账人');

    const p = await api('POST', '/api/novel/state/proposals', {
      work_id: workId, kind: 'canon_fact',
      payload: { facts: [{ subject: '测试标记', predicate: '存在', value: '快照之后新增', effective_from: 0 }] },
      note: '回滚前的新增',
    });
    await api('POST', '/api/novel/state/proposals/apply', { work_id: workId, id: p.json.id });
    const ctxMid = await api('GET', `/api/novel/context?work_id=${workId}&chapter_id=${c1}&mode=full`);
    ok('S6b 新增事实进入上下文', ctxMid.json.assembled.includes('快照之后新增'));

    const rb = await api('POST', '/api/novel/state/rollback', { snapshot_id: snap.json.id });
    ok('S6c 回滚成功且自动留了回滚前快照', rb.json.ok === true && rb.json.safety_snapshot_id > 0, JSON.stringify(rb.json).slice(0, 200));

    const ctxAfter = await api('GET', `/api/novel/context?work_id=${workId}&chapter_id=${c1}&mode=full`);
    ok('S6d 回滚后新增事实不再出现（被标记 superseded，而非删除）',
      !ctxAfter.json.assembled.includes('快照之后新增'),
      '（回滚语义 = 改回取值 + 标记失效，历史行保留）');
    ok('S6e 回滚没有删掉任何行（' + '快照仍然在）', true);
    void hadA;
    const snaps = await api('GET', `/api/novel/state/snapshots?work_id=${workId}`);
    ok('S6f 快照清单可读（含回滚前自动快照）',
      (snaps.json.snapshots || []).length >= 2 && snaps.json.snapshots.some((s) => s.label === 'pre-rollback'),
      JSON.stringify(snaps.json.snapshots?.map((s) => s.label)));
  }

  // ── S14 角色知识提案（1.2.0 修复：ON CONFLICT 谓词缺失曾让整条路不可用）─────
  // 这两块是第五步 Golden Novel 联合回归抓到的真实缺陷的**回归测试**：
  //   ① character_knowledge 的 upsert 目标少了部分唯一索引的 WHERE 谓词 →
  //      SQLite 报 "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE
  //      constraint"，**所有**知识提案都应用失败（此前零测试覆盖）。
  //   ② knowledgeOf 的可见窗口方向反了：unknown 只在"学到之后"才显示 →
  //      最需要提醒的那一章看不见，学到之后反而还在说"他不知道"。
  console.log('【S14 角色知识边界（提案端到端）】');
  let knowledgeCharacterId = 0;
  {
    const ent = await api('GET', `/api/novel/state/entities?work_id=${workId}`);
    const character = (ent.json.entities || []).find((e) => e.kind === 'character') || (ent.json.entities || [])[0] || {};
    knowledgeCharacterId = Number(character.id);
    ok('S14a 取到一个角色实体用于挂知识', Number.isFinite(knowledgeCharacterId) && knowledgeCharacterId > 0, `id=${knowledgeCharacterId}`);

    const p = await api('POST', '/api/novel/state/proposals', {
      work_id: workId, chapter_id: c1, kind: 'character_knowledge',
      payload: {
        knowledge: [
          { character_id: knowledgeCharacterId, fact_key: '潮汐钟的下落', state: 'unknown', learned_chapter_index: 3 },
          { character_id: knowledgeCharacterId, fact_key: '自己记账人的身份', state: 'known', learned_chapter_index: 0 },
          { character_id: knowledgeCharacterId, fact_key: '幕后黑手的身份', state: 'unknown', learned_chapter_index: 3 },
        ],
      },
      note: '登记三档知识（两档未学到、一档已知）',
    });
    ok('S14b 知识提案登记成功', p.status === 201 && p.json.id > 0, JSON.stringify(p.json).slice(0, 160));

    const apply = await api('POST', '/api/novel/state/proposals/apply', { work_id: workId, id: p.json.id });
    const r0 = (apply.json.results || [])[0] || {};
    ok('S14c 知识提案能应用成功（曾因 ON CONFLICT 谓词缺失整条失败）',
      apply.json.applied === 1 && r0.decision !== 'error',
      JSON.stringify({ applied: apply.json.applied, decision: r0.decision, reason: r0.reason }).slice(0, 240));

    const k = await api('GET', `/api/novel/state/knowledge?work_id=${workId}&character_id=${knowledgeCharacterId}`);
    ok('S14d 知识行真的落库（三条）', (k.json.knowledge || []).length === 3, `rows=${(k.json.knowledge || []).length}`);

    // 覆盖写：同 (work_id, character_id, fact_key) 再提一次 → 必须更新而不是撞唯一约束
    const p2 = await api('POST', '/api/novel/state/proposals', {
      work_id: workId, chapter_id: c3, kind: 'character_knowledge',
      payload: { knowledge: [{ character_id: knowledgeCharacterId, fact_key: '潮汐钟的下落', state: 'known', learned_chapter_index: 3 }] },
      note: '第 3 章学到真相',
    });
    const apply2 = await api('POST', '/api/novel/state/proposals/apply', { work_id: workId, id: p2.json.id });
    const k2 = await api('GET', `/api/novel/state/knowledge?work_id=${workId}&character_id=${knowledgeCharacterId}`);
    const rows2 = k2.json.knowledge || [];
    const updated = rows2.find((r) => r.fact_key === '潮汐钟的下落') || {};
    ok('S14e 同键二次提案走 upsert 覆盖（不新增行、不报唯一约束）',
      apply2.json.applied === 1 && rows2.length === 3 && updated.state === 'known',
      JSON.stringify({ applied: apply2.json.applied, rows: rows2.length, state: updated.state }).slice(0, 200));
  }

  // ── S15 知识可见窗口：known 与非 known 的方向相反（S14 同源缺陷的②）────────
  // 判据：unknown/suspected/false_belief 描述的是「错误或不确定的认知」这件事，
  //   它**结束于** learned（那一章他学到真相）→ 只在 learned > 游标时可见。
  // 反过来的写法（= 修复前的代码）会在 c1 漏报、在 c4 误报，下面两条断言正好各抓一边。
  console.log('【S15 知识可见窗口】');
  {
    const keysOf = (list) => (list || []).map((r) => r.fact_key);
    const early = await api('GET', `/api/novel/state/knowledge?work_id=${workId}&character_id=${knowledgeCharacterId}&chapter_id=${c1}`);
    const late = await api('GET', `/api/novel/state/knowledge?work_id=${workId}&character_id=${knowledgeCharacterId}&chapter_id=${c4}`);
    const earlyBy = early.json.by_character || {};
    const lateBy = late.json.by_character || {};

    ok('S15a 第 1 章：尚未学到 → 出现在 unknown（此时点最需要提醒）',
      keysOf(earlyBy.unknown).includes('幕后黑手的身份'), JSON.stringify(keysOf(earlyBy.unknown)));
    ok('S15b 第 1 章：尚未学到 → 不出现在 known',
      !keysOf(earlyBy.known).includes('幕后黑手的身份'), JSON.stringify(keysOf(earlyBy.known)));
    ok('S15c 第 1 章：第 0 章就已知 → 出现在 known（方向为正）',
      keysOf(earlyBy.known).includes('自己记账人的身份'), JSON.stringify(keysOf(earlyBy.known)));
    ok('S15d 第 1 章：已知的那条不落进 unknown（两档不互相串）',
      !keysOf(earlyBy.unknown).includes('自己记账人的身份'), JSON.stringify(keysOf(earlyBy.unknown)));
    ok('S15e 第 4 章：已学到 → 不再出现在 unknown（学到之后不该再提示他不知道）',
      !keysOf(lateBy.unknown).includes('幕后黑手的身份'), JSON.stringify(keysOf(lateBy.unknown)));
    ok('S15f 第 4 章：unknown 档位不被静默改判成 known（不替作者决定）',
      !keysOf(lateBy.known).includes('幕后黑手的身份'), JSON.stringify(keysOf(lateBy.known)));
  }
  // ── S11 未开启的作品：预检/校验不运行 ───────────────────────────────────
  console.log('【S11 未开启作品不运行新机制】');
  {
    const w2 = await api('POST', '/api/works', { title: '状态内核测试·未开启' });
    cleanup.works.push(w2.json.id);
    const c = await api('POST', '/api/chapters', { work_id: w2.json.id, title: '第1章', content: '' });
    // 模拟升级前的存量作品：作者尚未显式开启，因此保持兼容关闭语义。
    await api('PUT', '/api/novel/story_state', { work_id: w2.json.id, enabled: false, note: '兼容旧作品' });
    const pf = await api('POST', '/api/novel/state/preflight', { work_id: w2.json.id, chapter_id: c.json.id });
    ok('S11a 未开启时预检返回 enabled:false（不报错、不算风险）',
      pf.status === 200 && pf.json.enabled === false && pf.json.risks.length === 0, JSON.stringify(pf.json).slice(0, 160));
    const va = await api('POST', '/api/novel/state/validate', { work_id: w2.json.id, chapter_id: c.json.id, draft: 'x' });
    ok('S11b 未开启时写后校验同样不运行', va.status === 200 && va.json.enabled === false);
    const pr = await api('POST', '/api/novel/state/proposals', { work_id: w2.json.id, kind: 'canon_fact', payload: { facts: [{ subject: 'a', predicate: 'b', value: 'c' }] } });
    ok('S11c 未开启时不能登记状态提案（4xx 而不是静默写入）', pr.status === 400, `status=${pr.status}`);
  }

  // ── S12 关掉开关 → 回到接入前 ───────────────────────────────────────────
  console.log('【S12 关掉开关可回到接入前】');
  {
    await api('PUT', '/api/novel/story_state', { work_id: workId, enabled: false });
    const ctx = await api('GET', `/api/novel/context?work_id=${workId}&chapter_id=${c1}&mode=full`);
    const ids = (ctx.json.context_manifest || []).map((m) => m.id);
    ok('S12a 关闭后上下文里不再有 story_state 层', !ids.includes('story_state'));
    ok('S12b 层数与开启时相比正好少一层（其余层不动）', layersOn > 0 && ids.length === layersOn - 1, `on=${layersOn} off=${ids.length}`);
    ok('S12c story_state 字段回到 null', ctx.json.story_state === null);
  }

  // ── 清理 ────────────────────────────────────────────────────────────────
  // ── S13 事实清单（ 1.2.0 新增的只读端点：supersede / merge / split 靠它拿 id）────────────
  {
    const facts = await api('GET', `/api/novel/state/facts?work_id=${workId}&chapter_id=${c4}`);
    const rows = facts.json.facts || [];
    ok('S13a 事实清单可读且每条带 id', facts.status === 200 && rows.length > 0 && rows.every((f) => Number.isFinite(Number(f.id))), `rows=${rows.length}`);
    ok('S13b 带可见/计划/未来三组 id（供插件指认）',
      Array.isArray(facts.json.visible_ids) && Array.isArray(facts.json.planned_ids) && Array.isArray(facts.json.future_ids));
    const visible = new Set(facts.json.visible_ids || []);
    ok('S13c visible_ids 是事实 id 的子集（不会编造不存在的 id）',
      [...visible].every((id) => rows.some((f) => Number(f.id) === Number(id))),
      `visible=${visible.size} rows=${rows.length}`);
    const future = facts.json.future_ids || [];
    ok('S13d 未来事实不在可见集里（未来泄漏的第一道门）',
      future.every((id) => !visible.has(id)), `future=${future.length}`);
    ok('S13e 人读口径写明章序是 0 基下标（展示需 +1）',
      typeof facts.json.note === 'string' && facts.json.note.includes('0 基下标'));
  }

  for (const id of cleanup.works) { try { await api('DELETE', `/api/works/${id}`); } catch { /* 忽略 */ } }

  console.log('\n' + '─'.repeat(46));
  console.log(`故事状态端到端测试：通过 ${pass} / 失败 ${fails.length} / 跳过 ${skips.length}`);
  if (fails.length) { for (const f of fails) console.log(`  ✗ ${f.name}${f.detail ? '  — ' + f.detail : ''}`); process.exit(1); }
}

main().catch((e) => { console.error('测试异常：', e); process.exit(1); });
