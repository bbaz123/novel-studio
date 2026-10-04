import { spawn } from 'node:child_process';
import fs from 'node:fs';
try {
  const child = spawn(process.execPath, ['.p1-baseline/probe-spawn-child.mjs'], { shell: false, windowsHide: true, detached: true, stdio: 'ignore' });
  child.unref();
  fs.writeFileSync('.p1-baseline/spawn-attempt.txt', 'spawn() 调用未抛错 pid=' + (child.pid || 'n/a'));
} catch (e) {
  fs.writeFileSync('.p1-baseline/spawn-attempt.txt', 'spawn() 本身抛错: ' + e.code + ' ' + e.message);
}
