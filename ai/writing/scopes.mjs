/**
 * 写作规则的作用阶段（scopes）。
 *
 * 为什么要把阶段分开：同一条经验，用在不同阶段后果完全不同。
 * 「检查是否存在连续多段匿名群众反应」是**诊断**（verify_style）；
 * 一旦被当成正文生成禁令塞进 draft，就会变成新的机械模板——
 * 「不许写三个群众反应」和「不许写微微/缓缓」一样，只是换了一种工整。
 *
 * 2026-10-06（去 AI 味 P0）：规则按阶段声明，防止"审稿用规则"被错误塞进"正文生成"。
 */
export const WRITING_SCOPES = [
  'blueprint',     // 蓝图 / 写前规划
  'draft',         // 初稿成文
  'expand',        // 扩写 / 补写（只改已有段落，不在章尾追加）
  'rewrite',       // 修稿 / 重写
  'verify_fact',   // 事实审稿（哪里不成立）
  'verify_style'   // 叙述诊断（这段为什么不值得这样写）
];

export function isWritingScope(value) {
  return WRITING_SCOPES.includes(String(value || ''));
}