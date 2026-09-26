// 共享文本工具：HTML→纯文本 等，供 server.js 与 openviking-sync.js 复用，避免两处实现漂移。
// 保留段落边界（块级闭合标签转换行），实体解码顺序先解 &amp; 再解其它，避免二次解码。

export function htmlToPlain(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * HTML → 单行纯文本（压平空白）。
 *
 * 2026-09-24 从 server.js 搬到这里：原先它只存在于 server.js，而 ai/ 下的模块（记忆压缩
 * 提示词组装）也需要同一份实现。**同一件事有两份实现**正是本仓库反复吃亏的地方
 * （文件头那句「避免两处实现漂移」说的就是这件事），所以收敛到共享模块而不是再抄一份。
 */
export function plainText(html = '') {
  return htmlToPlain(html).replace(/\s+/g, ' ').trim();
}

// 上下文装配热点优化：只取头部/尾部时，先按倍数截取原始 HTML 再剥标签，
// 避免整章全文转换浪费（HTML 标签膨胀约 2-3 倍，截取后剥标签即可）。
export function plainTextHead(html = '', n = 3000) {
  const raw = String(html).slice(0, n * 3).replace(/<[^>]*$/, '');
  return plainText(raw).slice(0, n);
}

export function plainTextTail(html = '', n = 1200) {
  const raw = String(html).slice(-(n * 3)).replace(/^[^<]*>/, '');
  return plainText(raw).slice(-n);
}

export default htmlToPlain;
