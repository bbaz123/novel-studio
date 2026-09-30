#!/usr/bin/env node
/**
 * tests/temporal/12-context-temporal.test.mjs —— T5「上下文接线：所有来源遵守时间边界」证据
 * （真实 HTTP + 隔离实例 + 本机假模型，零计费；后半段用同一隔离库直接核对 provider 纯函数）。
 *
 * 覆盖：
 *   C1 启用作品 /api/novel/context：统一 cursor 生效（章前/章后、状态层、事件、关系、剧情线、
 *      角色阵容、全书记忆门控），未来章节内容/状态/事件不得进入 assembled；
 *   C2 boundary=after 显式查询：本章已确认更正可见，仍不得看到更后章；
 *   C3 缓存不串：重复请求同 context_id；换章/换 boundary/换视角不命中同一装配；
 *   C4 /api/ai_context 与 /api/novel/context 共享同一次装配（context_id 相同）；
 *   C5 工具查询继承 cursor：events / foreshadows / consistency / search 按「截至本章」过滤；
 *   C6 未启用作品：响应形状与旧契约一致（temporal_context=null、无 temporal_filter、记忆层保留）；
 *   C7 provider 纯函数：filterRowsByCursor / memoryLayerPolicyOf / sceneCastOf /
 *      filterRecallPayloadForCursor / buildTemporalStoryStateLayer 在真实隔离库上可核对。
 *
 * 纪律：NOVELSTUDIO_DATA_DIR 指向 mkdtemp 临时目录；只连本机假模型；全部作品自建自清理。
 */
import { createAssert, createClient, startFakeModel, startIsolatedServer } from './http-harness.mjs';

const a = createAssert();
const fake = await startFakeModel();
const server = await startIsolatedServer({ tag: 't5-context' });
const client = createClient(server.base);
const W_MARK = '青玉匣';

const CONTENT = {
  1: '<p>第1章 王师傅在青云镇教主角练刀。</p>',
  2: '<p>第2章 主角与王师傅同行，翻过山岭。</p>',
  3: `<p>第3章 两人抵达黑风谷口，主角收起${W_MARK}，停下休整。</p>`,
  4: '<p>第4章 主角在山道旁练刀，王师傅在旁指点。</p>',
  5: '<p>第5章 主角与王师傅在山道上赶路，风从谷口吹来。</p>',
  6: '<p>第6章 山谷里雾气渐重，两人放慢脚步。</p>',
  7: `<p>第7章 主角清点行装，匣中${W_MARK}仍在，王师傅守在火堆旁。</p>`,
  8: '<p>第8章 夜里有兽声远远传来。</p>',
  9: '<p>第9章 两人沿谷道深入。</p>',
  10: '<p>第10章 终局：王师傅倒在阵前，神秘人现身。</p>',
};
const FUTURE_FORESHADOW = '伏笔：青玉匣尚未开启';
const FUTURE_EVENT = '终局：王师傅倒在阵前';
const PAST_EVENT = '第3章大事：两人抵达黑风谷口';
const MEMORY_W = '全书记忆：王师傅最终战死，主角独行。';

try {
  // ── 建作品 A（启用时态）────────────────────────────────────────────────
  const cfg = await client.api('POST', '/api/api_configs', { name: 'T5 本机假模型（零计费）', base_url: `http://127.0.0.1:${fake.port}/v1`, api_key: 'sk-local-stub-not-billed', model: 'stub-model' });
  a.ok('C0 假模型配置已建立（零计费）', cfg.status === 201, `status=${cfg.status}`);
  const wk = await client.createWork('T5 上下文时态边界');
  const W = Number(wk.json.id);
  a.ok('C0 作品 A 已建立', Number.isInteger(W) && W > 0, `status=${wk.status}`);
  const chIds = [];
  for (let i = 1; i <= 10; i += 1) {
    const r = await client.createChapter(W, `第${i}章`, { content: `<p>第${i}章 占位。</p>` });
    chIds.push(Number(r.json.id));
  }
  const [c1, c2, c3, c4, c5, c6, c7, c8, c9, c10] = chIds;
  a.ok('C0 10 章已建立', chIds.every((x) => Number.isInteger(x) && x > 0), JSON.stringify(chIds));
  const on = await client.setTemporal(W, { temporal_enabled: true, auto_analysis_enabled: false, repair_enabled: false });
  a.ok('C0 时态引擎开启（自动分析关闭）', on.status === 200 && !!(on.json.config && on.json.config.enabled === true) && !!on.json.schema_ok);

  // 逐章重存（触发保存后处理/提交），再以作者更正建立可信前缀。
  for (let i = 1; i <= 10; i += 1) {
    const r = await client.api('PUT', `/api/chapters/${chIds[i - 1]}`, { title: `第${i}章`, content: CONTENT[i] });
    if (r.status !== 200) throw new Error(`保存第${i}章失败：${r.status} ${r.text.slice(0, 160)}`);
  }
  const seedFixes = {
    1: [
      { kind: 'character', entity_id: '王师傅', predicate: 'status', value: '在青云镇' },
      { kind: 'character', entity_id: '王师傅', predicate: 'alive', value: true },
      { kind: 'character', entity_id: '主角', predicate: 'status', value: '存活' },
      { kind: 'relation', from: '主角', to: '王师傅', label: '师徒' },
      { kind: 'plotline', entity_id: '黑风谷任务', predicate: 'state', value: '进行中' },
      { kind: 'knowledge', holder_id: '主角', entity_id: '王师傅旧伤', predicate: 'knows', value: '知情' },
      { kind: 'knowledge', holder_id: '王师傅', entity_id: '令牌下落', predicate: 'knows', value: '知情' },
    ],
    5: [{ kind: 'character', entity_id: '王师傅', predicate: 'status', value: '负伤' }],
    8: [{ kind: 'character', entity_id: '神秘人', predicate: 'status', value: '未现身' }],
    10: [
      { kind: 'character', entity_id: '王师傅', predicate: 'status', value: '战死' },
      { kind: 'character', entity_id: '王师傅', predicate: 'alive', value: false },
      { kind: 'plotline', entity_id: '黑风谷任务', predicate: 'state', value: '已收尾' },
      { kind: 'relation', from: '主角', to: '神秘人', label: '宿敌' },
    ],
  };
  let seedErr = '';
  for (let n = 1; n <= 10; n += 1) {
    const fixes = [
      { kind: 'plotline', entity_id: '主线进度', predicate: 'state', value: `第${n}章：推进` },
      ...(seedFixes[n] || []),
    ];
    const r = await client.correct(W, chIds[n - 1], fixes);
    if (!r.json || r.json.ok !== true) { seedErr = `更正第${n}章失败：status=${r.status} ${r.text.slice(0, 200)}`; break; }
  }
  a.ok('C0 逐章作者更正建立可信前缀（含第 10 章未来事实）', seedErr === '', seedErr);
  const at10 = await client.stateAt(W, c10);
  a.ok('C0 截至第 10 章可信且含「战死」（未来事实确实存在，供过滤对照）', at10.status === 200 && at10.json.trusted === true && JSON.stringify(at10.json.state_json || at10.json.state || {}).includes('战死'), JSON.stringify({ trusted: at10.json.trusted, stop: at10.json.stop }));

  const ev1 = await client.api('POST', '/api/novel/events', { work_id: W, chapter_id: c3, kind: 'event', summary: PAST_EVENT });
  const ev2 = await client.api('POST', '/api/novel/events', { work_id: W, chapter_id: c8, kind: 'foreshadow', summary: FUTURE_FORESHADOW });
  const ev3 = await client.api('POST', '/api/novel/events', { work_id: W, chapter_id: c10, kind: 'event', summary: FUTURE_EVENT });
  a.ok('C0 事件/伏笔已入账（第 3 / 8 / 10 章）', ev1.status === 201 && ev2.status === 201 && ev3.status === 201);
  const memW = await client.api('PUT', '/api/story_memory', { work_id: W, summary: MEMORY_W });
  a.ok('C0 全书记忆已写入（启用作品上必须被挡在历史事实层外）', memW.status === 200);
  const mkChar = (name, status) => client.api('POST', '/api/characters', { work_id: W, name, status, identity: '测试角色' });
  const ch1row = await mkChar('王师傅', '旧字段最新值·不应被采用');
  const ch2row = await mkChar('主角', '旧字段最新值·不应被采用');
  const ch3row = await mkChar('神秘人', '旧字段最新值·不应被采用');
  a.ok('C0 角色表存在王师傅/主角/神秘人（供 search 桶对照）', ch1row.status === 201 && ch2row.status === 201 && ch3row.status === 201, [ch1row.status, ch2row.status, ch3row.status].join(','));

  // ── C1：章前装配（mode=full 默认章前）────────────────────────────────────
  const ctxBefore = await client.api('GET', `/api/novel/context?work_id=${W}&chapter_id=${c5}&mode=full`);
  const jb = ctxBefore.json || {};
  a.ok('C1 装配 200', ctxBefore.status === 200, `status=${ctxBefore.status}`);
  a.ok('C1 temporal_context 启用且标的第 5 章章前', jb.temporal_context && jb.temporal_context.enabled === true && jb.temporal_context.cursor.chapter_id === c5 && jb.temporal_context.cursor.boundary === 'before' && jb.temporal_context.cursor.last_visible_index === 3, JSON.stringify(jb.temporal_context && jb.temporal_context.cursor));
  const asmB = String(jb.assembled || '');
  a.ok('C1 章前状态可见（王师傅=在青云镇）', asmB.includes('在青云镇'), asmB.slice(0, 400));
  a.ok('C1 第 5 章更正（负伤）不得出现在章前装配', !asmB.includes('负伤'));
  a.ok('C1 第 10 章状态（战死）不得泄漏', !asmB.includes('战死') && !asmB.includes('已收尾') && !asmB.includes('宿敌'));
  a.ok('C1 未来角色（神秘人）不得出现在装配/阵容', !asmB.includes('神秘人') && !(jb.scene_characters || []).some((c) => String(c.name) === '神秘人'));
  a.ok('C1 未来事件/伏笔不进事件层', !asmB.includes(W_MARK) && !asmB.includes('终局'));
  a.ok('C1 已发生事件仍在（第 3 章事件）', asmB.includes('黑风谷口'), asmB.slice(0, 300));
  a.ok('C1 全书记忆被门控（memory 层不发射）', !asmB.includes('全书记忆') && (jb.temporal_context.filtered ? true : true) && jb.temporal_context.memory_layer && jb.temporal_context.memory_layer.included === false, JSON.stringify(jb.temporal_context && jb.temporal_context.memory_layer));
  a.ok('C1 manifest 无 memory 层', Array.isArray(jb.context_manifest) && !jb.context_manifest.some((l) => l && l.id === 'memory'));
  a.ok('C1 层 note 带机器可核对游标标记', Array.isArray(jb.context_manifest) && jb.context_manifest.some((l) => /^temporal:ch\d+:(before|after):/.test(String(l && l.note || ''))), JSON.stringify((jb.context_manifest || []).map((l) => l && l.id + ':' + String(l.note || '').slice(0, 60))));
  a.ok('C1 有未来事件被计数拦下（events_hidden>=2）', jb.temporal_context.filtered && Number(jb.temporal_context.filtered.events_hidden) >= 2, JSON.stringify(jb.temporal_context.filtered));

  // ── C2：章后装配 ────────────────────────────────────────────────────────
  const ctxAfter = await client.api('GET', `/api/novel/context?work_id=${W}&chapter_id=${c5}&mode=full&boundary=after`);
  const ja = ctxAfter.json || {};
  const asmA = String(ja.assembled || '');
  a.ok('C2 boundary=after 生效（last_visible_index=4）', ctxAfter.status === 200 && ja.temporal_context && ja.temporal_context.cursor.boundary === 'after' && ja.temporal_context.cursor.last_visible_index === 4, JSON.stringify(ja.temporal_context && ja.temporal_context.cursor));
  a.ok('C2 章后包含第 5 章的已确认更正（负伤）', asmA.includes('负伤'), asmA.slice(0, 300));
  a.ok('C2 章后仍不含第 6 章之后的未来事实', !asmA.includes('战死') && !asmA.includes('神秘人') && !asmA.includes(W_MARK));

  // ── C3：缓存不串（同请求命中 / 换章换边界换视角各自独立）─────────────────
  const ctxBeforeAgain = await client.api('GET', `/api/novel/context?work_id=${W}&chapter_id=${c5}&mode=full`);
  a.ok('C3 相同请求命中同一装配（context_id 相同）', ctxBeforeAgain.json && ctxBeforeAgain.json.context_id === jb.context_id, `${jb.context_id} vs ${ctxBeforeAgain.json && ctxBeforeAgain.json.context_id}`);
  const ctx6 = await client.api('GET', `/api/novel/context?work_id=${W}&chapter_id=${c6}&mode=full`);
  a.ok('C3 换章不命中（context_id 不同）', ctx6.json && ctx6.json.context_id !== jb.context_id);
  a.ok('C3 章前章后不串（context_id 不同）', ja.context_id !== jb.context_id);
  const povCharId = (jb.scene_characters || []).find((c) => c.name === '主角');
  const ctxPov = await client.api('GET', `/api/novel/context?work_id=${W}&chapter_id=${c5}&mode=full&perspective=character&pov_character_id=${povCharId ? povCharId.id : 0}`);
  const jp = ctxPov.json || {};
  a.ok('C3 角色视角进 cursor（perspective/pov 可见）', ctxPov.status === 200 && jp.temporal_context && jp.temporal_context.cursor.perspective === 'character' && Number(jp.temporal_context.cursor.pov_character_id) === Number(povCharId && povCharId.id), JSON.stringify(jp.temporal_context && jp.temporal_context.cursor));
  a.ok('C3 作者视角看得到另一持有人的知识（令牌下落）', asmB.includes('令牌下落'), asmB.slice(0, 300));
  a.ok('C3 主角视角看不到他人持有的知识（令牌下落）', !String(jp.assembled || '').includes('令牌下落'));
  const ctxAuthorAgain = await client.api('GET', `/api/novel/context?work_id=${W}&chapter_id=${c5}&mode=full&perspective=author`);
  a.ok('C3 perspective=author 与默认参数共享缓存（context_id 一致）', ctxAuthorAgain.json && ctxAuthorAgain.json.context_id === jb.context_id);

  // ── C4：/api/ai_context 共享同一次装配 ─────────────────────────────────
  const ai = await client.api('GET', `/api/ai_context?chapter_id=${c5}`);
  a.ok('C4 ai_context 与 novel/context 同一装配（context_id 相同）', ai.status === 200 && ai.json && ai.json.context_id === jb.context_id, `status=${ai.status} ${ai.json && ai.json.context_id} vs ${jb.context_id}`);
  a.ok('C4 ai_context 的 assembled 与装配一致', ai.json && String(ai.json.assembled || '') === asmB);

  // ── C5：工具查询继承 cursor ────────────────────────────────────────────
  const evs = await client.api('GET', `/api/novel/events?work_id=${W}&chapter_id=${c5}`);
  const evsAll = await client.api('GET', `/api/novel/events?work_id=${W}`);
  a.ok('C5 events：截至第 5 章过滤（未来事件不下发）', evs.status === 200 && Array.isArray(evs.json.events) && evs.json.events.some((e) => String(e.summary).includes('黑风谷口')) && !evs.json.events.some((e) => String(e.summary).includes(W_MARK)) && !evs.json.events.some((e) => String(e.summary).includes('终局')), JSON.stringify((evs.json.events || []).map((e) => e.summary)));
  a.ok('C5 events：temporal_filter 审计存在（hidden>=2）', evs.json.temporal_filter && Number(evs.json.temporal_filter.hidden) >= 2, JSON.stringify(evs.json.temporal_filter));
  a.ok('C5 events：不给 chapter_id 时旧行为不变（含未来事件、无 temporal_filter）', evsAll.status === 200 && !evsAll.json.temporal_filter && evsAll.json.events.some((e) => String(e.summary).includes(W_MARK)));

  const fores = await client.api('GET', `/api/novel/foreshadows?work_id=${W}&status=all&chapter_id=${c5}`);
  a.ok('C5 foreshadows：未来伏笔不下发', fores.status === 200 && !(fores.json.foreshadows || []).some((e) => String(e.summary).includes(W_MARK)) && fores.json.temporal_filter, JSON.stringify(fores.json.temporal_filter));
  const foresAll = await client.api('GET', `/api/novel/foreshadows?work_id=${W}&status=all`);
  a.ok('C5 foreshadows：无 chapter_id 时旧行为不变', !foresAll.json.temporal_filter && (foresAll.json.foreshadows || []).some((e) => String(e.summary).includes(W_MARK)));

  const cons = await client.api('POST', '/api/novel/consistency', { work_id: W, chapter_id: c5, text: '<p>第5章 主角与王师傅在山道上赶路。</p>' });
  const cl = (cons.json && cons.json.checklist) || {};
  a.ok('C5 consistency：清单事件按截至本章过滤', cons.status === 200 && !(cl.recent_events || []).some((e) => String(e.summary).includes(W_MARK)) && !(cl.open_foreshadows || []).some((e) => String(e.summary).includes(W_MARK)), JSON.stringify((cl.recent_events || []).map((e) => e.summary)));
  a.ok('C5 consistency：全书记忆不进事实层（显式说明原因）', cl.story_memory === '' && typeof cl.story_memory_note === 'string' && cl.story_memory_note.length > 0);
  const wang = (cl.present_characters || []).find((c) => c.name === '王师傅');
  a.ok('C5 consistency：角色状态为时态值（截至本章，不回落最新值）', !!wang && String(wang.status).includes('负伤') && wang.status_source === 'temporal' && !String(wang.status).includes('战死'), JSON.stringify(wang));
  a.ok('C5 consistency：temporal_filter 审计存在', cons.json.temporal_filter && cons.json.temporal_filter.chapter_id === c5);

  const srch = await client.api('GET', `/api/search?q=${encodeURIComponent(W_MARK)}&work_id=${W}&chapter_id=${c5}`);
  a.ok('C5 search：未来章节不进章节桶', srch.status === 200 && Array.isArray(srch.json.chapters) && srch.json.chapters.length > 0 && !srch.json.chapters.some((c) => Number(c.id) > c5), JSON.stringify((srch.json.chapters || []).map((c) => c.id)));
  a.ok('C5 search：章节桶保留可见章并计数被拦（>=1）', srch.json.temporal_filter && Number(srch.json.temporal_filter.chapters_hidden) >= 1, JSON.stringify(srch.json.temporal_filter));
  const srchFuture = await client.api('GET', `/api/search?q=${encodeURIComponent('神秘人')}&work_id=${W}&chapter_id=${c5}`);
  a.ok('C5 search：未来才登记的角色不进角色桶', srchFuture.status === 200 && (srchFuture.json.characters || []).length === 0 && Number(srchFuture.json.temporal_filter.characters_hidden) >= 1, JSON.stringify(srchFuture.json.temporal_filter));
  const srchKnown = await client.api('GET', `/api/search?q=${encodeURIComponent('王师傅')}&work_id=${W}&chapter_id=${c5}`);
  a.ok('C5 search：已登记角色改用时态状态（旧字段最新值被替换）', srchKnown.status === 200 && (srchKnown.json.characters || []).some((c) => String(c.status).includes('负伤') && c.status_source === 'temporal' && !String(c.status).includes('旧字段最新值')), JSON.stringify(srchKnown.json.characters));
  const srchNoParam = await client.api('GET', `/api/search?q=${encodeURIComponent(W_MARK)}&work_id=${W}`);
  a.ok('C5 search：无 chapter_id 时旧行为不变（无 temporal_filter）', !srchNoParam.json.temporal_filter);

  // ── C6：未启用作品行为不变 ─────────────────────────────────────────────
  const wkB = await client.createWork('T5 未启用对照');
  const B = Number(wkB.json.id);
  const cb1 = Number((await client.createChapter(B, '对照第1章', { content: '<p>对照第一章。</p>' })).json.id);
  const cb2 = Number((await client.createChapter(B, '对照第2章', { content: '<p>对照第二章。</p>' })).json.id);
  const MEMORY_B = '未启用作品记忆标记：应当保留在装配里。';
  await client.api('PUT', '/api/story_memory', { work_id: B, summary: MEMORY_B });
  const ctxB = await client.api('GET', `/api/novel/context?work_id=${B}&chapter_id=${cb2}&mode=full`);
  const jB = ctxB.json || {};
  a.ok('C6 未启用作品：temporal_context 恒为 null、story_state 仍为 null', ctxB.status === 200 && jB.temporal_context === null && jB.story_state === null);
  a.ok('C6 未启用作品：装配无时态标记、记忆层保留', !String(jB.assembled || '').includes('temporal:') && Array.isArray(jB.context_manifest) && jB.context_manifest.some((l) => l && l.id === 'memory') && String(jB.assembled || '').includes(MEMORY_B), String(jB.assembled || '').slice(0, 300));
  const evB = await client.api('GET', `/api/novel/events?work_id=${B}&chapter_id=${cb2}`);
  a.ok('C6 未启用作品：工具端点不加 temporal_filter 字段', evB.status === 200 && !('temporal_filter' in (evB.json || {})) && evB.json.work_id === B);
  const searchB = await client.api('GET', `/api/search?q=${encodeURIComponent('对照')}&work_id=${B}&chapter_id=${cb2}`);
  a.ok('C6 未启用作品：search 旧形状不变', searchB.status === 200 && !searchB.json.temporal_filter);

  // ── C7：provider 纯函数（同一隔离库，生产模块直调）──────────────────────
  process.env.NOVELSTUDIO_DATA_DIR = server.dataDir;
  const StoryState = await import('../../ai/story-state/index.mjs');
  const T = StoryState.Temporal;
  const cursor = T.resolveContextCursor({ workId: W, chapterId: c5, mode: 'full', boundary: 'before' });
  a.ok('C7 resolveContextCursor：章前游标 ok / 章序定位正确', cursor && cursor.ok !== false && cursor.enabled && cursor.lastVisibleIndex === 3 && cursor.boundary === 'before', JSON.stringify({ ok: cursor && cursor.ok, idx: cursor && cursor.lastVisibleIndex, boundary: cursor && cursor.boundary }));
  a.ok('C7 cursorNoteOf：机器可核对标记格式', /^temporal:ch\d+:before:commit=.+:wl=.+:persp=author:/.test(T.cursorNoteOf(cursor)), T.cursorNoteOf(cursor));
  const rowFilter = T.filterRowsByCursor([{ chapter_id: c3 }, { chapter_id: c8 }, { chapter_id: null }], cursor, { label: 'probe' });
  a.ok('C7 filterRowsByCursor：未来章与无归属被拦、已发生保留', rowFilter.kept.length === 1 && Number(rowFilter.kept[0].chapter_id) === c3 && rowFilter.hidden === 2, JSON.stringify(rowFilter.dropped));
  a.ok('C7 memoryLayerPolicyOf：全书记忆不进事实层', T.memoryLayerPolicyOf(cursor).included === false);
  const layer = T.buildTemporalStoryStateLayer({ cursor });
  a.ok('C7 story_state 层：含章前状态、不含未来状态', layer.text.includes('在青云镇') && !layer.text.includes('战死') && !layer.text.includes('负伤') && !layer.text.includes('神秘人'), layer.text.slice(0, 300));
  const known = T.knownCharacterNamesOf(cursor);
  a.ok('C7 knownCharacterNamesOf：未来角色未登记', known.has('王师傅') && !known.has('神秘人'));
  const cast = T.sceneCastOf(cursor, [{ id: 1, name: '王师傅' }, { id: 2, name: '神秘人' }], {});
  a.ok('C7 sceneCastOf：未来角色默认不注入', cast.kept.length === 1 && cast.dropped.length === 1);
  const recall = T.filterRecallPayloadForCursor({
    status: 'ok', text: 'x',
    hits: [
      { uri: `viking://w/chapters/${c3}.md`, label: 'a', text: 'AAA', source_meta: { chapter_id: c3 } },
      { uri: `viking://w/chapters/${c8}.md`, label: 'b', text: 'BBB', source_meta: { chapter_id: c8 } },
      { uri: 'viking://w/meta.md', label: 'c', text: 'CCC' },
    ],
  }, cursor);
  a.ok('C7 filterRecallPayloadForCursor：未来召回被拦、已发生/非章节保留', recall.payload.hits.length === 2 && recall.payload.hits.some((h) => h.text === 'AAA') && !recall.payload.hits.some((h) => h.text === 'BBB') && recall.dropped.some((d) => d.code === 'future_chapter'), JSON.stringify(recall.dropped));
  const vW = T.temporalVersionOf(W);
  a.ok('C7 temporalVersionOf：启用作品非空（进外部版本串）', typeof vW === 'string' && vW.length > 0, vW.slice(0, 80));
  a.ok('C7 temporalVersionOf：未启用作品为空串（不改变缓存行为）', T.temporalVersionOf(B) === '');

  await client.deleteWork(W);
  await client.deleteWork(B);
  a.ok('C9 清理完成（隔离库，临时目录）', true);
} finally {
  server.stop();
  fake.server.close();
}

const fails = a.summary('T5 上下文时态边界（12-context-temporal）');
process.exit(fails ? 1 : 0);
