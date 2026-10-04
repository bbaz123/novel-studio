import { spawn } from 'node:child_process';
import fs from 'node:fs';
const child = spawn(process.execPath, ['-e', 'console.log("child-ok")'], { shell: false, windowsHide: true });
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.on('error', (e) => { fs.writeFileSync('.p1-baseline/spawn-capability.txt', 'SPAWN_ERROR ' + e.code); process.exit(0); });
child.on('close', () => { fs.writeFileSync('.p1-baseline/spawn-capability.txt', 'SPAWN_OK out=' + out.trim()); });
