/**
 * continuity-guard-source.mjs —— 把库里的真实数据装配成 `continuity-guard` 的输入。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────────────
 * 预检要在**三处**跑同一套装配：服务端端点（界面用）、验收脚本（离线量命中率）、
 * 以及将来可能的内联提示词路径。"每处各写一遍 SQL"必然漂移（本仓库已经有过多处
 * 口径不一致的教训：字数口径、红线字段名）。所以装配只写一次，靠注入的
 * `all/get` 两个查询函数工作——不 import db，保持可离线单测、导入零副作用
 * （与 `ai/memory-compress-guard.mjs`、`openviking.js`、`harness.js` 同一条纪律）。
 *
 * ⚠️ 这里**只读**：不写库、不调 AI、不发网络请求。
 */
import { runContinuityChecks } from './continuity-guard.mjs';
// 复用共享的 HTML→纯文本实现（`text-utils.js` 的文件头写着：供 server.js 与 openviking-sync.js 复用，
// 避免两处实现漂移）。字数口径必须与界面一致，所以这里**不新写一个剥标签正则**。
import { htmlToPlain } from '../text-utils.js';

/** 作品级阈值 / 豁免在 app_settings 里的键前缀（零迁移：key-value 表本来就够用）。 */
export const CONTINUITY_EXEMPTIONS_PREFIX = 'continuity_exemptions:';
export const CONTINUITY_THRESHOLDS_PREFIX = 'continuity_thresholds:';

/**
 * 装配一所章的全部判据输入。
 *
 * @param {{all: (sql: string, ...p: any[]) => any[], get: (sql: string, ...p: any[]) => any}} deps
 *        查询函数（服务端传 `prepare(...).all/get`，脚本传只读连接的同一对函数）。
 * @param {{workId: number, chapterId?: number|null, text?: string}} args
 *        `text`：要检查的正文**纯文本**（成文弹窗传草稿；审稿传待审正文）。
 *        省略时取库里这一章的正文。
 */
export function gatherContinuityInput({ all, get }, { workId, chapterId = null, text = null } = {}) {
  const work = get('SELECT id, title, total_chapters, story_structure, default_chapter_words, style_positive FROM works WHERE id = ?', workId);
  if (!work) return null;
  const chapter = chapterId
    ? get('SELECT id, work_id, volume_id, plotline_id, title, summary, content, position, target_words FROM chapters WHERE id = ?', chapterId)
    : null;
  if (chapterId && (!chapter || Number(chapter.work_id) !== Number(workId))) return null;

  const volumes = all('SELECT id, title, position FROM volumes WHERE work_id = ? ORDER BY position ASC, id ASC', workId);
  const chapters = all('SELECT id, position, plotline_id, volume_id, title, target_words FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC', workId);
  const writtenRows = all("SELECT position FROM chapters WHERE work_id = ? AND LENGTH(TRIM(COALESCE(content,''))) > 0", workId);
  const characters = all('SELECT id, name, status, identity FROM characters WHERE work_id = ? ORDER BY id ASC', workId);
  const plotlines = all('SELECT id, title, kind FROM plotlines WHERE work_id = ? ORDER BY position ASC, id ASC', workId);

  // 本章的卷内位置：用于"卷末状态被用在卷中"这一条。
  // 没有卷信息（或本章未分卷）时不判——判据缺一半时**不猜**（猜测会制造假阳性）。
  const volumeOrdinal = volumes.find((v) => Number(v.id) === Number(chapter?.volume_id))?.position;
  const volumeId = chapter?.volume_id ?? null;
  const sameVolume = volumeId ? chapters.filter((c) => Number(c.volume_id) === Number(volumeId)) : [];
  const idx = chapter ? sameVolume.findIndex((c) => Number(c.id) === Number(chapter.id)) : -1;
  const maxVolumeOrdinal = volumes.length ? Math.max(...volumes.map((v) => Number(v.position))) : null;

  const currentPosition = chapter ? Number(chapter.position) : (writtenRows.length ? Math.max(...writtenRows.map((r) => Number(r.position))) : null);
  // ⚠️ 两条来源（库里存的 HTML 正文 / 调用方传来的草稿纯文本）都走同一次 `htmlToPlain`：
  //    字数口径只有一条路，才不会出现"界面显示 3897、预检说 4505"这种自相矛盾。
  //    `htmlToPlain` 对没有标签的纯文本是恒等的（只压空白），所以对草稿也安全。
  // ⚠️ 空串按"没传"处理、回退到库里正文：前端在拿不到草稿文本时会传空串（例如刷新预检块时），
  //    若把空串当正文，预检会"零命中"——那是**假的通过**，比不跑更糟。
  const provided = text !== null && text !== undefined && String(text).trim() !== '';
  const body = htmlToPlain(provided ? text : (chapter?.content || ''));

  return {
    chapter: {
      id: chapter?.id ?? null,
      position: currentPosition,
      // 标题本身已经带"第X章"（50 章都是这个格式），不再自己拼前缀，避免「第 1 章 第一章 …」重复。
      label: chapter ? String(chapter.title || `第 ${Number(chapter.position) + 1} 章`) : '',
      volumeOrdinal: Number.isFinite(volumeOrdinal) ? Number(volumeOrdinal) : null,
      indexInVolume: idx >= 0 ? idx : null,
      chaptersInVolume: sameVolume.length || null,
      isFinalVolume: (Number.isFinite(volumeOrdinal) && Number.isFinite(maxVolumeOrdinal))
        ? Number(volumeOrdinal) === Number(maxVolumeOrdinal) : null,
    },
    characters,
    plotlines,
    chapters,
    writtenPositions: writtenRows.map((r) => Number(r.position)),
    currentPosition,
    chapterTarget: Number(chapter?.target_words) || 0,
    workDefault: Number(work.default_chapter_words) || 0,
    styleText: String(work.style_positive || ''),
    text: body,
    meta: {
      workId: Number(workId),
      workTitle: work.title,
      chapterId: chapter?.id ?? null,
      fromDb: !provided,
    },
  };
}

/**
 * 端到端一次：装配 + 跑检查（含豁免过滤）。返回 `{ ok, result, input, meta }`。
 * 失败（作品/章节不存在）返回 `{ ok: false, reason }`，由调用方决定 HTTP 状态码。
 */
export function computeContinuityGuard(deps, args = {}) {
  const input = gatherContinuityInput(deps, args);
  if (!input) return { ok: false, reason: '作品或章节不存在（或章节不属于该作品）' };
  const result = runContinuityChecks({
    chapter: input.chapter,
    characters: input.characters,
    plotlines: input.plotlines,
    chapters: input.chapters,
    writtenPositions: input.writtenPositions,
    currentPosition: input.currentPosition,
    chapterTarget: input.chapterTarget,
    workDefault: input.workDefault,
    styleText: input.styleText,
    text: input.text,
    thresholds: args.thresholds || {},
    exemptions: args.exemptions || [],
    systemAliases: args.systemAliases || [],
  });
  return { ok: true, result, input, meta: input.meta };
}
