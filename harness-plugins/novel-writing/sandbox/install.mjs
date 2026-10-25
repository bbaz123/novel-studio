#!/usr/bin/env node
/**
 * 沙箱引导：`node --import <本文件>` 时在业务代码之前装上进程级出口沙箱。
 *
 * 为什么不直接 `--import egress-preload.mjs`：preload 只导出函数，不自动安装——
 * 导出函数是为了可离线断言（import 时不应有副作用）；安装必须显式。
 */
import fs from 'node:fs'
import { installEgressSandbox } from './egress-preload.mjs'

const sandbox = installEgressSandbox()

process.env.NOVELSTUDIO_EGRESS_ACTIVE = '1'

// 子进程退出时落一份摘要：调用方据此判断“沙箱确实装上并拒绝过什么”。
process.on('exit', () => {
  const file = process.env.NOVELSTUDIO_EGRESS_SUMMARY
  if (!file) return
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, ...sandbox.summary(), denials: sandbox.denials() }, null, 2) + '\n')
  } catch {
    /* 摘要写失败不影响退出码 */
  }
})
