#!/usr/bin/env node
/**
 * census.mjs —— 只读现场普查：谁在监听、谁写了日志、我的作业落在哪个库里。
 *
 * 为什么需要：本轮出现「以为打的是隔离实例、实际上是另一个数据目录的旧实例」，
 * 必须能一次性把「进程 ↔ 端口 ↔ 数据目录 ↔ 日志」对起来，否则会误判成真实付费调用
 * （或反过来漏判）。
 *
 * 只读：不启动/不停止任何进程，只查询进程列表、端口、以及各数据目录的日志文件。
 * 用法: node .p1-baseline/census.mjs [jobIdFragment ...]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const fragments = process.argv.slice(2);

function ps(cmd) {
  return execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
}

console.log('═══ 1. node 进程 ↔ 端口 ═══');
let procs = [];
try {
  const raw = ps(
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress"
  ).trim();
  const arr = raw ? JSON.parse(raw) : [];
  procs = Array.isArray(arr) ? arr : [arr];
} catch (e) {
  console.log('  取进程失败:', e.message);
}

let listen = {};
try {
  const raw = ps(
    "Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0','::') } | " +
    "Select-Object LocalPort,OwningProcess | ConvertTo-Json -Compress"
  ).trim();
  const arr = raw ? JSON.parse(raw) : [];
  for (const x of (Array.isArray(arr) ? arr : [arr])) {
    (listen[x.OwningProcess] ||= []).push(x.LocalPort);
  }
} catch (e) {
  console.log('  取端口失败:', e.message);
}

for (const p of procs) {
  const ports = listen[p.ProcessId] || [];
  const cmd = String(p.CommandLine || '').replace(/\s+/g, ' ');
  console.log(`  PID=${p.ProcessId} 起于 ${p.CreationDate} 端口=[${ports.join(',')}]`);
  console.log(`     ${cmd.slice(0, 150)}`);
}

console.log('\n═══ 2. 各数据目录的启动日志（谁在什么时候起过服务）═══');
const DIRS = [
  'data',
  '.p1-baseline/data',
  '.p1-baseline/stress-data',
  '.test-data-gate',
  '.test-data-trace',
];
for (const d of DIRS) {
  const logDir = path.join(REPO, d, 'logs');
  if (!fs.existsSync(logDir)) { console.log(`  ${d}/logs —— 不存在`); continue; }
  const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.log'));
  for (const f of files) {
    const full = path.join(logDir, f);
    const st = fs.statSync(full);
    let starts = 0, lastTs = '';
    for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.kind === 'lifecycle') { starts++; lastTs = o.ts; }
      } catch { /* 非 JSON 行 */ }
    }
    console.log(`  ${d}/logs/${f}  ${st.size}B 改于 ${st.mtime.toISOString()}  启动次数=${starts} 最后一次=${lastTs}`);
  }
}

if (fragments.length) {
  console.log('\n═══ 3. 按作业号碎片定位日志 ═══');
  const roots = DIRS.map((d) => path.join(REPO, d, 'logs')).filter((p) => fs.existsSync(p));
  for (const frag of fragments) {
    console.log(`  ── 碎片 "${frag}" ──`);
    let hits = 0;
    for (const root of roots) {
      for (const f of fs.readdirSync(root)) {
        const full = path.join(root, f);
        const text = fs.readFileSync(full, 'utf8');
        if (!text.includes(frag)) continue;
        for (const line of text.split(/\r?\n/)) {
          if (line.includes(frag)) { hits++; console.log(`     ${path.relative(REPO, full)}: ${line.slice(0, 220)}`); }
        }
      }
    }
    if (!hits) console.log('     （无命中）');
  }
}

console.log('\n═══ 4. 真实库 / 副本 是否出现 harness 或真实 API 痕迹 ═══');
for (const d of ['data', '.p1-baseline/data']) {
  const p = path.join(REPO, d, 'novel.db');
  if (!fs.existsSync(p)) continue;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(p, { readOnly: true });
    const t = db.prepare("SELECT count(*) c FROM app_logs WHERE layer='harness'").get();
    const max = db.prepare("SELECT max(ts) m FROM app_logs WHERE layer='harness'").get();
    console.log(`  ${d}/novel.db  harness 层日志 ${t.c} 条，最后一条 ${max.m || '（无）'}`);
    db.close();
  } catch (e) {
    console.log(`  ${d}/novel.db 查询失败: ${e.message}`);
  }
}
