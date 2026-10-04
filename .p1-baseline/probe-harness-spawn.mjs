import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'process.stdout.write("dsh-child-ok")'], {
  cwd: process.cwd(), shell: false, windowsHide: true, env: process.env
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.on('error', (e) => { console.log('SPAWN_ERROR ' + e.code); process.exit(0); });
child.on('close', (code) => { console.log(`SPAWN_OK code=${code} stdout=${out}`); });
