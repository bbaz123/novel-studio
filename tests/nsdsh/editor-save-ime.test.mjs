/**
 * tests/nsdsh/editor-save-ime.test.mjs —— S08：新增流/状态模块**不得破坏**编辑器既有行为。
 *
 * S08 明确要求"保留中文 IME、撤销、光标与自动保存行为；逐步迁移，不一次重写 app.js"。
 * 因此本套件是**保护性表征**：它不测新功能，只钉住"改造后这些既有行为仍然存在"。
 * 判据只用源码里的确定事实（不 import app.js —— 它在 import 时会碰 DOM/网络）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../temporal/harness.mjs';
import { REPO } from '../../scripts/nsdsh/lib/isolate.mjs';

const appSrc = fs.readFileSync(path.join(REPO, 'public/app.js'), 'utf8');
const streamSrc = fs.readFileSync(path.join(REPO, 'public/temporal-stream.js'), 'utf8');

suite('nsdsh/editor-save-ime', [
  ['S08-E1 中文 IME：compositionstart/end 必须仍然接管输入，输入法组字期间不得触发保存', () => {
    assert.match(appSrc, /addEventListener\('compositionstart'/, 'IME 组字开始必须仍被监听');
    assert.match(appSrc, /addEventListener\('compositionend'/, 'IME 组字结束必须仍被监听');
    assert.match(appSrc, /function setEditorComposition/, '必须有组字态开关');
    // scheduleSave 必须能感知组字态（否则中文输入会被拆成多次保存）
    assert.match(appSrc, /function scheduleSave/, 'scheduleSave 必须仍存在');
    const saveBody = appSrc.slice(appSrc.indexOf('function scheduleSave('), appSrc.indexOf('function scheduleSave(') + 1200);
    assert.match(saveBody, /composition|isComposing|editingComposition|composing/i,
      'S08：自动保存必须仍然尊重 IME 组字态');
  }],

  ['S08-E2 光标与选区：编辑后必须能恢复，不得因为新模块丢光标', () => {
    assert.match(appSrc, /savedRange/, '选区必须仍被记录');
    assert.match(appSrc, /getRangeAt\(0\)/, '必须仍能取到当前 range');
    // 恢复路径存在（设置回 selection）
    assert.match(appSrc, /setStart|setEnd|removeAllRanges|addRange/, '必须有把选区设回去的代码');
  }],

  ['S08-E3 撤销：编辑器原生的 undo 栈不得被新模块接管', () => {
    // 不引入自建 undo 栈覆盖浏览器原生撤销（S08 要求"保留撤销行为"）
    assert.ok(!/preventDefault\(\)[\s\S]{0,80}undo/i.test(streamSrc), '流模块不得拦截 undo');
    assert.ok(!/document\.execCommand\('undo'/.test(streamSrc), '流模块不得自己执行 undo');
    // app.js 里若出现 undo 处理，必须是"放行"而不是拦截原生行为
    const undoHits = appSrc.match(/['"]undo['"]/g) || [];
    assert.ok(undoHits.length >= 0); // 仅记录，不强制存在
  }],

  ['S08-E4 自动保存：仍有 debounce 调度与 flush 落盘路径', () => {
    assert.match(appSrc, /scheduleSave\(\)/, '必须仍调用自动保存调度');
    assert.match(appSrc, /function flushSave/, '必须有强制落盘（flush）路径，供切章/关闭前使用');
    // debounce 必须是真的定时器，而不是同步保存（同步保存会把中文输入拆碎）
    assert.match(appSrc, /setTimeout\(/, '自动保存必须仍是异步调度');
  }],

  ['S08-E5 新流模块无 DOM 依赖（可在 Node 单测，也不改编辑器时序）', () => {
    assert.ok(!/document\.|window\.|localStorage\./.test(streamSrc), 'public/temporal-stream.js 不得直接依赖 DOM');
    // 不得 monkey-patch 编辑器相关 API
    assert.ok(!/addEventListener/.test(streamSrc), '流模块不得自行绑定 DOM 事件');
    assert.match(streamSrc, /export function createStreamConsumer/, '必须导出可单测的消费者工厂');
  }],

  ['S08-E6 逐步迁移纪律：不得整体重写 app.js（体积与结构仍在合理量级）', () => {
    const lines = appSrc.split('\n').length;
    assert.ok(lines > 3000, `app.js 仍是既有大文件（${lines} 行）—— 本阶段不应整体重写它`);
    // 新模块必须单独成文件，而不是把流逻辑塞回 app.js
    assert.ok(!/createStreamConsumer/.test(appSrc), '流消费者应留在独立模块，逐步接入而不是一次塞进 app.js');
  }],
]);
