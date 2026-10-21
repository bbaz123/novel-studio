/**
 * 提交幂等：同一份 payload 重复提交时，不发第二次请求（本地去重），
 * 同时在服务端仍保留"相同摘要幂等 / 不同摘要冲突"的第二道保护。
 *
 * 为什么两处都要：本地去重避免模型在重试循环里把同一份结果反复提交；
 * 服务端判定保证"就算本地状态丢了（进程重启）也不会被覆盖"。
 */
import { createHash } from 'node:crypto';

export function payloadDigest(payload) {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(payload == null ? null : payload), 'utf8').digest('hex');
}

export function createIdempotencyStore() {
  const seen = new Map();
  return {
    key(operation, payload) { return String(operation) + '|' + payloadDigest(payload); },
    has(operation, payload) { return seen.has(this.key(operation, payload)); },
    remember(operation, payload) { seen.set(this.key(operation, payload), true); },
    size() { return seen.size; },
  };
}
