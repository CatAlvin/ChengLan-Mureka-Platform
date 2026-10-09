import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const port = Number(process.env.PORT || 4173);
const { app, runner } = await buildApp({ root, port, publicOrigin: process.env.PUBLIC_ORIGIN, dataDir: process.env.DATA_DIR, storageDir: process.env.STORAGE_DIR });
try {
  await app.listen({ host: '127.0.0.1', port });
  runner.start();
  void runner.refreshAccount();
  console.log(`橙蓝音乐工作台已启动：http://127.0.0.1:${port}`);
} catch {
  console.error(`无法启动本机服务。请检查端口 ${port} 是否已被使用。`);
  await app.close(); process.exitCode = 1;
}
for (const event of ['SIGINT', 'SIGTERM'] as const) process.once(event, () => { void app.close().then(() => process.exit(0)); });
