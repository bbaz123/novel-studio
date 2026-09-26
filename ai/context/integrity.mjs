/**
 * integrity.mjs —— 上下文的**完整性判定**（PASS / WARNING / FAIL）。纯函数、零依赖。
 *
 * ── 为什么需要 ────────────────────────────────────────────────────────────────
 * 清单（manifest）只有在**与真正发给模型的文字一致**时才有意义。否则它描述的是一份
 * 想象出来的上下文：工具照着它做审计、界面照着它提示作者、而模型收到的是另一份东西——
 * 这种"看起来有护栏、其实是装饰"的形态是本仓库反复吃过亏的地方。
 *
 * 所以这里不只检查"看起来对不对"，而是**重新核算**：把清单里每层的占用加起来，
 * 与真正那段文字的长度逐字节对齐；再用内容哈希钉住"这份清单与这段文字同源"。
 *
 * ── 等级怎么定（不是拍脑袋）──────────────────────────────────────────────────
 *   FAIL    契约被破坏，且**会**影响模型看到的内容：
 *             · 清单与文字不一致（C1）—— 审计与提示都失去依据
 *             · 某层超过自己的 cap（C2）—— 契约 I2
 *             · 零损失层被裁（C3）—— 零损失承诺为假
 *             · 超预算却**没有**显式标记（C4b）—— 契约 I1 的"不静默超限"
 *             · 有内容被丢掉却没有标记为截断（C8）—— 静默裁剪
 *             · 文字的内容哈希与清单不符（C6）—— 装配后被改写
 *   WARNING 现状可接受，但需要如实告知（不是错误，是**已知缺口**）：
 *             · 超预算但已显式标记（C4a）
 *             · 被截断的层当前没有查回路径（C5）—— 诚实标注，不假装完整
 *             · 某层没有溯源声明（C7）—— 无法回答"这段字从哪来"
 *   PASS    以上都没有发生。
 *
 * ── FAIL 为什么不直接拦截生成 ─────────────────────────────────────────────────
 * 「拦截」是**改变真实用户可观察行为**（作品写不出来）。本轮的纪律是最小行为变更：
 * FAIL 时**响亮记录**（error 级日志 + 响应字段 + 工具断言），由人决定；是否升级为拦截
 * 属于产品决策，不在本轮范围内自行决定。
 */

import { createHash } from 'node:crypto';

/** 内容哈希：取 sha256 前 12 位十六进制，作为「这段上下文」的稳定标识。 */
export function shortHash(text, len = 12) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, len);
}

/** 层间分隔符（`assembler.mjs` 用 '\n\n' 连接；这里作为常量引用，避免两处各写一份）。 */
const SEPARATOR = '\n\n';

/**
 * 校验一份（清单 + 文字）是否自洽。
 *
 * @param {object} o
 * @param {string} o.text          真正发给模型的那段上下文
 * @param {Array}  o.manifest      装配器产出的逐层清单
 * @param {object|null} o.overflow 压到下限仍超预算时的显式标记
 * @param {number} o.budget        本次总预算（字符）
 * @param {string} [o.contextId]   装配时写进清单的内容哈希（缺省则不查 C6）
 * @returns {{status:'PASS'|'WARNING'|'FAIL', checks:Array, failed:string[], warned:string[]}}
 */
export function verifyContextIntegrity({ text, manifest, overflow = null, budget = 0, contextId = '' } = {}) {
  const body = String(text ?? '');
  const rows = Array.isArray(manifest) ? manifest.filter(Boolean) : [];
  const checks = [];
  const add = (id, level, ok, detail) => checks.push({ id, level, ok: !!ok, detail });

  // C1：清单逐层占用之和 == 实际文字长度（含层间分隔符）
  const sumRendered = rows.reduce((n, r) => n + (Number(r.renderedLength) || 0), 0);
  const expected = sumRendered + Math.max(0, rows.length - 1) * SEPARATOR.length;
  add('C1', 'fail', expected === body.length,
    `清单合计 ${expected} 字 vs 实际 ${body.length} 字`);

  // C2：每层不得突破自己的 cap（cap 是硬上界；entity 层的 cap 是 Infinity，跳过）
  const capped = rows.filter((r) => Number.isFinite(r.declaredCap) && r.declaredCap !== null);
  const overCap = capped.filter((r) => Number(r.emitted) > Number(r.declaredCap));
  add('C2', 'fail', overCap.length === 0,
    overCap.length ? overCap.map((r) => `${r.id}:${r.emitted}>${r.declaredCap}`).join(' / ') : `${capped.length} 层在各自 cap 内`);

  // C3：零损失层（kind=fixed）**永不参与收缩**（契约 I3）。
  //
  // ⚠️ 判据是 `shrunk`（被总预算收敛循环压过），**不是** `truncated`：
  // 「不参与收缩」指的是"不因为总预算不够而被压"，而**超过本层 cap** 时它照样按 cap 截断
  // ——这是长期以来的既有行为（实测：work#16 第 108 章，memory/events/foreshadows/redlines
  //   四层都被各自 cap 截断，且都能查回）。第一版判据把两者混为一谈，在真实数据上直接误报 FAIL；
  // 是"在真实作品上跑一遍"把它暴露出来的。被 cap 截断的可回退性由 C5 负责。
  const zeroLoss = rows.filter((r) => r.kind === 'fixed');
  const broken = zeroLoss.filter((r) => r.shrunk === true);
  add('C3', 'fail', broken.length === 0,
    broken.length ? `被总预算收缩：${broken.map((r) => r.id).join(' / ')}` : `${zeroLoss.length} 个不收缩层没有被预算收敛压过`);

  // C4：总长与预算的关系
  if (body.length <= budget) {
    add('C4', 'fail', true, `${body.length} ≤ 预算 ${budget}`);
  } else if (overflow) {
    add('C4', 'warn', false, `超出预算 ${body.length - budget} 字，但已显式标记（契约 I1 要求"不静默"）`);
  } else {
    add('C4', 'fail', false, `超出预算 ${body.length - budget} 字且**没有**标记（静默超限）`);
  }

  // C5：凡被截断，必须能查回（有工具名，或该层本身就是检索结果）
  const trimmed = rows.filter((r) => r.truncated === true || Number(r.dropped) > 0);
  // ⚠️ 字段名必须是清单里真实存在的那个（`recoveryPath`）。第一版写成 snake_case
  // `recovery_path`，于是每个被裁层都被判成"没有查回路径"——在真实数据上是一次全量误报。
  const noPath = trimmed.filter((r) => {
    const p = r.recoveryPath;
    return !(p && (p.tool || p.intrinsic === true));
  });
  add('C5', 'warn', noPath.length === 0,
    noPath.length ? `无查回路径：${noPath.map((r) => r.id).join(' / ')}` : `${trimmed.length} 个被裁层都有查回路径`);

  // C6：内容哈希（钉住"这份清单与这段文字同源"）
  if (contextId) {
    const actual = shortHash(body);
    add('C6', 'fail', actual === contextId, `清单 ${contextId} vs 实际 ${actual}`);
  }

  // C7：每层都要能回答"这段字从哪来"
  const noSource = rows.filter((r) => !r.source);
  add('C7', 'warn', noSource.length === 0,
    noSource.length ? `无溯源声明：${noSource.map((r) => r.id).join(' / ')}` : `${rows.length} 层都有溯源`);

  // C8：不许有"静默裁剪"——被裁了就必须标出来
  const silent = rows.filter((r) => Number(r.dropped) > 0 && r.truncated !== true);
  add('C8', 'fail', silent.length === 0,
    silent.length ? silent.map((r) => r.id).join(' / ') : '没有静默裁剪');

  const failed = checks.filter((c) => !c.ok && c.level === 'fail').map((c) => c.id);
  const warned = checks.filter((c) => !c.ok && c.level === 'warn').map((c) => c.id);
  const status = failed.length ? 'FAIL' : (warned.length ? 'WARNING' : 'PASS');
  return { status, checks, failed, warned };
}

/**
 * 人话版摘要（给日志与界面用）。**不隐藏 WARNING**：已知缺口要一直看得见，
 * 否则"有查回路径"会慢慢变成一句没人核对的口号。
 */
export function integritySummary(v) {
  const r = v || {};
  const bad = (r.checks || []).filter((c) => !c.ok);
  if (!bad.length) return `上下文完整性 PASS（${(r.checks || []).length} 项检查全通过）`;
  return `上下文完整性 ${r.status}：` + bad.map((c) => `${c.id} ${c.detail}`).join('；');
}