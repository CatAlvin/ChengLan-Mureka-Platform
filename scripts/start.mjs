import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const address = 'http://127.0.0.1:4173';
const noBrowser = process.argv.includes('--no-browser');
async function running() {
  try {
    const response = await fetch(`${address}/api/session`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const info = await response.json();
    return info.app === 'chenglan-music' || (['0.1.0', '0.2.0'].includes(info.version) && typeof info.csrfToken === 'string' && /^[0-9a-f]{64}$/.test(info.csrfToken));
  } catch { return false; }
}
function browse() {
  if (noBrowser) return;
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', address] : [address];
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
if (process.argv.includes('--stop')) {
  if (await running()) {
    const response = await fetch(`${address}/api/session`);
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const { csrfToken } = await response.json();
    const controlFile = path.join(root, 'data/control-token');
    const result = await fetch(`${address}/api/shutdown`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrfToken, ...(existsSync(controlFile) ? { 'x-chenglan-control': readFileSync(controlFile, 'utf8').trim() } : {}) } });
    if (!result.ok) throw new Error('Could not stop this version. See README.md.');
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (!(await running())) break;
    }
    if (await running()) throw new Error('The service is still shutting down. Wait before moving data folders.');
    console.log('ChengLan has stopped. You can now back up or restore data.');
  } else console.log('ChengLan is already stopped.');
  process.exit(0);
}
if (!(await running())) {
  if (!existsSync(path.join(root, 'node_modules'))) throw new Error('Run pnpm install first. See README.md.');
  if (!existsSync(path.join(root, 'apps/server/dist/index.js')) || !existsSync(path.join(root, 'apps/web/dist/index.html'))) {
    const result = spawnSync('pnpm', ['build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.status !== 0) process.exit(1);
  }
  mkdirSync(path.join(root, 'data'), { recursive: true });
  const output = openSync(path.join(root, 'data/server.out.log'), 'a');
  const errors = openSync(path.join(root, 'data/server.err.log'), 'a');
  const child = spawn(process.execPath, [path.join(root, 'apps/server/dist/index.js')], {
    cwd: root, detached: true, windowsHide: true, stdio: ['ignore', output, errors],
  });
  closeSync(output); closeSync(errors);
  if (child.pid) writeFileSync(path.join(root, 'data/server.pid'), String(child.pid));
  child.unref();
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 400));
    if (await running()) { ready = true; break; }
    if (child.exitCode !== null) break;
  }
  if (!ready) throw new Error('The app did not start. Check data/server.err.log or whether port 4173 is already in use.');
}
console.log(`ChengLan is ready: ${address}`);
browse();
