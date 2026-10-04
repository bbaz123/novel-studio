import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'console.log("child-ok")'], { shell: false, windowsHide: true });
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.on('error', (e) => { console.log('SPAWN_ERROR ' + e.code); process.exit(0); });
child.on('close', () => { console.log('SPAWN_OK out=' + out.trim()); });
