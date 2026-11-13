import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { randomUUID, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { z } from 'zod';
import { draftSchema, generationSchema, toolInputSchema, toolRangeError, toolNames, type Job, type JobKind } from '../../../packages/shared/src/index.js';
import { Store } from './db.js';
import { MurekaProvider, type MusicProvider } from './provider.js';
import { Runner } from './runner.js';
import type { Downloader } from './media.js';
import type { AudioProcessor } from './postprocess.js';
import { registerLibraryRoutes } from './library-routes.js';
import { initializeUsers, registerAuth } from './auth.js';
import { sourceError } from './materials.js';
import { scoreFilename } from './score-files.js';
import { CreditError } from './credits.js';

type AppOptions = { root: string; port?: number; provider?: MusicProvider; downloader?: Downloader; archiveDownloader?: Downloader; processor?: AudioProcessor; dataDir?: string; storageDir?: string; logger?: boolean; publicOrigin?: string; bootstrap?: { username: string; password: string } };
const idParams = z.object({ id: z.string().uuid() });
function safeFilename(title: string) { return Array.from(title).map(char => char.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(char) ? '_' : char).join('').replace(/[. ]+$/, '') || 'music'; }
function attachment(name: string) { return `attachment; filename="music${path.extname(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`; }

export async function buildApp(options: AppOptions) {
  const port = options.port ?? 4173;
  const dataDir = options.dataDir ?? path.join(options.root, 'data');
  const storageDir = options.storageDir ?? path.join(options.root, 'storage');
  mkdirSync(storageDir, { recursive: true });
  let key = process.env.MUREKA_API_KEY?.trim() ?? '';
  if (!key && !options.provider) {
    try { key = readFileSync(process.env.MUREKA_API_KEY_FILE || path.join(options.root, 'Mureka-API-Key.txt'), 'utf8').trim(); } catch { /* Connection status explains a missing key. */ }
  }
  const provider = options.provider ?? new MurekaProvider(key);
  const store = new Store(dataDir);
  const runner = new Runner(store, provider, storageDir, options.downloader, options.processor, options.archiveDownloader);
  await initializeUsers(store, options.root, options.bootstrap);
  const app = Fastify({ trustProxy: options.publicOrigin ? ['127.0.0.1', '::1'] : false, logger: options.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie', 'req.body.password', 'req.body.currentPassword'] } : false, bodyLimit: 64 * 1024 });
  await app.register(cookie);
  const controlToken = options.publicOrigin ? undefined : randomBytes(32).toString('hex');
  if (controlToken) writeFileSync(path.join(dataDir, 'control-token'), controlToken, { mode: 0o600 });
  registerAuth(app, store, runner, { port, publicOrigin: options.publicOrigin, controlToken });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof CreditError) return reply.code(402).send({ message: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ message: error.issues[0]?.message || '输入格式有误', fields: error.flatten().fieldErrors });
    const code = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 500;
    reply.code(code >= 400 && code < 500 ? code : 500).send({ message: code === 413 ? '内容太大，请缩短后重试。' : '本机操作未完成，请重试；原有数据仍然保留。' });
  });
  app.get('/api/snapshot', async request => ({ jobs: request.userStore.publicJobs(), tracks: request.userStore.publicTracks(), account: request.user!.role === 'admin' ? runner.account : { ...runner.account, balance: null, totalSpending: null, error: runner.account.connected ? null : '创作服务暂时未就绪，请稍后再试。' }, storageBytes: await runner.storageBytes(request.userStore), materials: request.userStore.publicMaterials(), collections: request.userStore.listCollections(), credits: runner.credits.balance(request.user!.id) }));
  registerLibraryRoutes(app, store, runner, storageDir);
  app.post('/api/account/refresh', async request => { const account = await runner.refreshAccount(request.user!.role === 'admin'); return request.user!.role === 'admin' ? account : { ...account, balance: null, totalSpending: null }; });
  app.get('/api/drafts', async request => request.userStore.listDrafts());
  app.put('/api/drafts', async request => { const input = draftSchema.parse(request.body); request.userStore.saveDraft(input); return { savedAt: Date.now() }; });

  async function enqueue(store: Store, body: unknown, kind?: JobKind) {
    const envelope = z.object({ submissionId: z.string().uuid(), input: kind === 'lyrics' ? draftSchema : generationSchema }).parse(body);
    if (kind === 'lyrics' && !envelope.input.prompt.trim()) throw new z.ZodError([{ code: 'custom', path: ['prompt'], message: '先描述一下你想写什么样的歌词' }]);
    const jobKind = kind || (envelope.input.mode === 'instrumental' ? 'instrumental' : 'song');
    const existing = store.getSubmission(envelope.submissionId);
    if (existing) {
      if (existing.kind !== jobKind || JSON.stringify(existing.input) !== JSON.stringify(envelope.input)) {
        const error = new Error('提交标识冲突'); Object.assign(error, { statusCode: 409 }); throw error;
      }
      return existing;
    }
    if (jobKind !== 'lyrics') {
      const message = sourceError(store, envelope.input);
      if (message) throw new z.ZodError([{ code: 'custom', path: ['source'], message }]);
    }
    if (envelope.input.collectionId) {
      const collection = store.getCollection(envelope.input.collectionId);
      if (!collection || collection.archivedAt) throw new z.ZodError([{ code: 'custom', path: ['collectionId'], message: '作品集已归档或不存在，请重新选择。' }]);
    }
    const job: Job = { id: randomUUID(), submissionId: envelope.submissionId, input: envelope.input, kind: jobKind,
      status: 'local_queued', providerId: null, error: null, traceId: null, result: null, createdAt: Date.now(), updatedAt: Date.now(), pollAfter: 0 };
    store.sqlite.transaction(() => { store.saveDraft(envelope.input); store.createJob(job); runner.credits.reserve(job.id); })();
    return job;
  }
  app.post('/api/jobs', async (request, reply) => { const job = await enqueue(request.userStore, request.body); reply.code(202); return job; });
  app.post('/api/lyrics', async (request, reply) => { const job = await enqueue(request.userStore, request.body, 'lyrics'); reply.code(202); return job; });
  app.post('/api/tools', async (request, reply) => {
    const store = request.userStore;
    const { submissionId, tool } = z.object({ submissionId: z.string().uuid(), tool: toolInputSchema }).parse(request.body);
    const existing = store.getSubmission(submissionId);
    if (existing) {
      if (JSON.stringify(existing.tool) !== JSON.stringify(tool)) return reply.code(409).send({ message: '这次提交的内容已改变，请先核对创作记录。' });
      return reply.code(202).send(store.publicJobs().find(j => j.id === existing.id));
    }
    const source = store.getTrack(tool.sourceTrackId);
    if (!source || source.deletedAt) return reply.code(404).send({ message: '请先从作品库选择一首可用的作品。' });
    if (source.saveStatus !== 'saved' || !source.localFile) return reply.code(409).send({ message: '请等这首作品保存完成，再继续创作。' });
    const rangeError = toolRangeError(tool, source.duration);
    if (rangeError) return reply.code(400).send({ message: rangeError });
    const original = store.getJob(source.jobId)!;
    const input = { ...original.input, title: tool.title || `${source.title.slice(0, 60)} · ${toolNames[tool.operation]}`, count: 1, ...(tool.operation === 'track' ? { mode: tool.generateType === 'Vocals' ? 'lyrics' as const : 'instrumental' as const, lyrics: tool.generateType === 'Vocals' ? tool.lyrics : '', source: null } : {}) };
    const job: Job = { id: randomUUID(), submissionId, kind: tool.operation, tool, input, status: 'local_queued', providerId: null, error: null, traceId: null, result: null, createdAt: Date.now(), updatedAt: Date.now(), pollAfter: 0 };
    store.sqlite.transaction(() => { store.createJob(job); runner.credits.reserve(job.id); })();
    return reply.code(202).send(job);
  });
  app.post('/api/jobs/:id/save', async (request, reply) => {
    const store = request.userStore;
    const { id } = idParams.parse(request.params); const job = store.getJob(id);
    if (!job || !['stem', 'crop', 'transcribe'].includes(job.kind) || job.status !== 'save_failed') return reply.code(409).send({ message: '这项任务不需要重新保存。' });
    if (job.kind === 'crop') store.updateJob(id, { status: 'local_queued', error: null });
    else if (job.kind === 'transcribe') void runner.saveScore(id);
    else void runner.saveStems(id);
    return reply.code(202).send({ ok: true });
  });
  app.post('/api/jobs/:id/cancel', async (request, reply) => {
    const store = request.userStore;
    const { id } = idParams.parse(request.params); const job = store.getJob(id);
    if (!job) return reply.code(404).send({ message: '没有找到这项任务。' });
    if (job.status !== 'local_queued') return reply.code(409).send({ message: '任务已经提交，无法在本机取消云端生成。' });
    store.sqlite.transaction(() => { runner.credits.release(id); store.updateJob(id, { status: 'cancelled', error: '已取消尚未提交的本地任务。' }); })(); return { ok: true };
  });
  app.post('/api/jobs/:id/reconcile', async (request, reply) => {
    const store = request.userStore;
    const { id } = idParams.parse(request.params);
    const body = z.object({ checked: z.literal(true), providerId: z.string().regex(/^[\w-]{1,128}$/).optional() }).parse(request.body);
    const job = store.getJob(id);
    if (!job || job.status !== 'submission_unknown') return reply.code(409).send({ message: '只有提交待核实的任务需要此操作。' });
    if (body.providerId) return reply.code(400).send({ message: '请联系管理员核对云端任务；共享账户不能直接关联未经验证的任务编号。' });
    store.updateJob(id, { status: 'failed', error: '用户已核对上游记录并关闭本地待核实状态。这不会取消云端任务。' });
    return { ok: true };
  });
  app.patch('/api/tracks/:id', async (request, reply) => {
    const store = request.userStore;
    const { id } = idParams.parse(request.params);
    const patch = z.object({ title: z.string().trim().min(1).max(80).optional(), favorite: z.boolean().optional(), deleted: z.boolean().optional(), collectionId: z.string().uuid().nullable().optional() }).parse(request.body);
    if (!store.getTrack(id)) return reply.code(404).send({ message: '没有找到这首作品。' });
    if (patch.collectionId) { const collection = store.getCollection(patch.collectionId); if (!collection || collection.archivedAt) return reply.code(400).send({ message: '请选择一个未归档的作品集。' }); }
    const { deleted, ...rest } = patch;
    store.updateTrack(id, { ...rest, ...(deleted === undefined ? {} : { deletedAt: deleted ? Date.now() : null }) });
    return { ok: true };
  });
  app.post('/api/tracks/:id/save', async (request, reply) => {
    const store = request.userStore;
    const { id } = idParams.parse(request.params); const track = store.getTrack(id);
    if (!track || track.deletedAt) return reply.code(404).send({ message: '没有找到可保存的作品。' });
    void runner.saveTrack(id); reply.code(202); return { ok: true };
  });
  const webRoot = path.join(options.root, 'apps/web/dist');
  await app.register(staticFiles, { root: existsSync(webRoot) ? webRoot : storageDir, serve: existsSync(webRoot), dotfiles: 'deny' });
  app.get('/media/:id', async (request, reply) => {
    const store = request.userStore;
    const { id } = idParams.parse(request.params); const track = store.getTrack(id);
    if (!track || track.deletedAt || !track.localFile || track.saveStatus !== 'saved') return reply.code(404).send({ message: '作品尚未保存完整，请稍等或点击重新保存。' });
    const query = z.object({ download: z.string().optional(), bundle: z.literal('1').optional() }).parse(request.query);
    reply.header('Cache-Control', 'private, no-cache');
    if (query.download) {
      const name = safeFilename(track.title);
      if (query.bundle && track.lyricsFile) {
        const entries: Record<string, Uint8Array> = {};
        for (const file of [track.localFile, track.lyricsFile, track.timedLyricsFile]) {
          if (file) entries[name + path.extname(file)] = await readFile(path.join(storageDir, file));
        }
        return reply.type('application/zip').header('Content-Disposition', attachment(`${name}.zip`)).send(Buffer.from(zipSync(entries, { level: 0 })));
      }
      reply.header('Content-Disposition', attachment(`${name}${path.extname(track.localFile)}`));
    }
    return reply.type(track.contentType || 'audio/mpeg').sendFile(track.localFile, storageDir, { cacheControl: false });
  });
  app.get('/api/tracks/:id/lyrics', async (request, reply) => {
    const store = request.userStore;
    const { id } = idParams.parse(request.params); const track = store.getTrack(id);
    const { format } = z.object({ format: z.enum(['txt', 'lrc']).default('txt') }).parse(request.query);
    const file = format === 'lrc' ? track?.timedLyricsFile : track?.lyricsFile;
    if (!track || track.deletedAt || track.saveStatus !== 'saved' || !file) return reply.code(404).send({ message: '这首作品暂时没有对应的歌词文件。' });
    return reply.type('text/plain; charset=utf-8').header('Content-Disposition', attachment(`${safeFilename(track.title)}.${format}`)).sendFile(file, storageDir, { cacheControl: false });
  });
  app.get('/api/jobs/:id/download', async (request, reply) => {
    const store = request.userStore;
    const { id } = idParams.parse(request.params); const job = store.getJob(id);
    if (!job || job.kind !== 'stem' || job.status !== 'succeeded') return reply.code(404).send({ message: '分轨还未保存完整。' });
    const outputs = store.listTracks().filter(t => t.jobId === id && !t.deletedAt);
    if (!outputs.length || outputs.some(t => t.saveStatus !== 'saved')) return reply.code(409).send({ message: '请先完成音轨保存。' });
    const entries: Record<string, Uint8Array> = {}; let size = 0;
    for (const [index, track] of outputs.entries()) {
      for (const file of [track.localFile, track.lyricsFile, track.timedLyricsFile]) {
        if (!file) continue;
        const data = await readFile(path.join(storageDir, file)); size += data.byteLength;
        if (size > 300 * 1024 * 1024) return reply.code(413).send({ message: '分轨文件较大，请分别下载。' });
        entries[`${index + 1}-${safeFilename(track.stemName || track.title)}${path.extname(file)}`] = data;
      }
    }
    return reply.type('application/zip').header('Content-Disposition', attachment(`${safeFilename(job.input.title)}.zip`)).send(Buffer.from(zipSync(entries, { level: 0 })));
  });
  app.get('/api/jobs/:id/files/:fileId', async (request, reply) => {
    const { id, fileId } = z.object({ id: z.string().uuid(), fileId: z.string().uuid() }).parse(request.params);
    const job = request.userStore.getJob(id);
    const file = job && ['transcribe', 'stem'].includes(job.kind) && job.status === 'succeeded' ? job.result?.scoreFiles?.find(f => f.id === fileId) : undefined;
    if (!file) return reply.code(404).send({ message: '没有找到已保存的结果文件。' });
    const mime = file.format === 'pdf' ? 'application/pdf' : ['mid', 'midi'].includes(file.format) ? 'audio/midi' : file.format === 'json' ? 'application/json' : 'application/vnd.recordare.musicxml+xml';
    return reply.type(mime).header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').header('Content-Disposition', attachment(safeFilename(file.name))).sendFile(scoreFilename(file), storageDir, { cacheControl: false });
  });
  app.post('/api/backup', async (request, reply) => {
    const store = request.userStore;
    // A complete offline backup, including tracks in the recycle bin, without credentials.
    const folder = path.join(dataDir, `backup-${randomUUID()}`);
    await mkdir(folder, { recursive: true });
    try {
      const database = path.join(folder, 'chenglan.sqlite');
      await store.backupForUser(database);
      const entries: Record<string, Uint8Array> = { 'chenglan.sqlite': await readFile(database), 'manifest.json': strToU8(JSON.stringify({ version: 8, createdAt: new Date().toISOString(), app: 'chenglan-music' })) };
      let total = entries['chenglan.sqlite'].byteLength;
      for (const file of store.storageFiles()) {
          const data = await readFile(path.join(storageDir, file)); total += data.byteLength;
          if (total > 300 * 1024 * 1024) return reply.code(413).send({ message: '作品超过 300 MB，请停止应用后手动备份 data 和 storage 文件夹。' });
          entries[`storage/${file}`] = data;
      }
      const zip = zipSync(entries, { level: 0 });
      return reply.type('application/zip').header('Content-Disposition', 'attachment; filename="chenglan-backup.zip"').send(Buffer.from(zip));
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  app.get('/api/info', async request => ({ version: '0.7.3', storageDir: request.user!.role === 'admin' ? storageDir : '个人作品空间', dataDir: request.user!.role === 'admin' ? dataDir : '个人创作数据', provider: 'Mureka 中国区', sharedAccess: true }));
  app.post('/api/shutdown', async (_request, reply) => {
    await runner.stop();
    reply.send({ ok: true });
    // Finish the response before draining current network/file work and closing SQLite.
    setTimeout(() => { void app.close(); }, 100);
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/media/') || !existsSync(path.join(webRoot, 'index.html'))) return reply.code(404).send({ message: '没有找到这个页面。' });
    if (path.extname(request.url.split('?')[0]) && !request.url.startsWith('/create')) return reply.code(404).send({ message: '没有找到这个文件。' });
    return reply.type('text/html').sendFile('index.html', webRoot);
  });
  app.addHook('onClose', async () => { await runner.stop(); store.close(); });
  return { app, store, runner };
}
