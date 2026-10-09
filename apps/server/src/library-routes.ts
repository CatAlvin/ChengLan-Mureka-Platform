import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';
import { z } from 'zod';
import { emptyDraft, terminalStatuses } from '../../../packages/shared/src/index.js';
import type { Store } from './db.js';
import type { Runner } from './runner.js';
import { importMaterial, MAX_MATERIAL_BYTES, MAX_MUSIC_BYTES } from './materials.js';
import { AUDIO_PROCESSING_VERSION } from './postprocess.js';

const idSchema = z.object({ id: z.string().uuid() });
const nameSchema = z.string().trim().min(1, '请填写名称').max(80);
const safeName = (value: string) => Array.from(value).map(c => c.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(c) ? '_' : c).join('').replace(/[. ]+$/, '') || 'music';
const attachment = (name: string) => `attachment; filename="music${path.extname(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`;
async function sendExport(reply: FastifyReply, directory: string, title: string, audio: string, lyrics: (string | null)[], bundle: boolean) {
  const name = safeName(title);
  reply.header('Cache-Control', 'private, no-cache');
  if (bundle && lyrics.some(Boolean)) {
    const entries: Record<string, Uint8Array> = {};
    for (const file of [audio, ...lyrics]) if (file) entries[name + path.extname(file)] = await readFile(path.join(directory, file));
    return reply.type('application/zip').header('Content-Disposition', attachment(`${name}.zip`)).send(Buffer.from(zipSync(entries, { level: 0 })));
  }
  return reply.header('Content-Disposition', attachment(`${name}${path.extname(audio)}`)).sendFile(audio, directory, { cacheControl: false });
}
export function registerLibraryRoutes(app: FastifyInstance, globalStore: Store, runner: Runner, directory: string) {
  const imports = new Map<string, { hash: string; ownerId: string; kind: 'music' | 'material'; task: Promise<void> }>();
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_MUSIC_BYTES }, (_request, body, done) => done(null, body));
  app.post('/api/tracks/import', { bodyLimit: MAX_MUSIC_BYTES }, async (request, reply) => {
    const store = request.userStore;
    const { id, name, title } = z.object({ id: z.string().uuid(), name: nameSchema, title: nameSchema.optional() }).parse(request.query);
    if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ message: '请选择一个音频文件。' });
    const bytes = request.body; const hash = createHash('sha256').update(bytes).digest('hex');
    const existing = store.getTrack(id);
    if (existing) {
      if (existing.origin !== 'uploaded' || existing.checksum !== hash || existing.deletedAt) return reply.code(409).send({ message: '这次上传编号已使用。若作品在回收站，请先恢复。' });
      return store.publicTracks().find(track => track.id === id);
    }
    if (globalStore.getTrack(id) || globalStore.getMaterial(id)) return reply.code(409).send({ message: '上传编号已使用，请重新选择文件。' });
    const running = imports.get(id);
    if (running && (running.ownerId !== request.user!.id || running.hash !== hash || running.kind !== 'music')) return reply.code(409).send({ message: '同一次上传的文件或账户发生了变化，请重试。' });
    if (!running && imports.size >= 2) return reply.code(429).send({ message: '正在处理其他音频，请稍后再上传。' });
    try {
      const task = running?.task || (async () => {
        const files = await importMaterial(bytes, name, directory, randomUUID(), MAX_MUSIC_BYTES);
        try {
          const disabled = (globalStore.sqlite.prepare('SELECT disabled FROM users WHERE id=?').get(request.user!.id) as { disabled: number } | undefined)?.disabled;
          if (disabled) throw new Error('账户已停用');
          const input = { ...emptyDraft('easy'), title: title || path.parse(name).name.slice(0, 80) || '我的上传音乐' };
          const jobId = randomUUID(); const now = Date.now();
          store.sqlite.transaction(() => {
            store.createJob({ id: jobId, submissionId: randomUUID(), kind: 'import', input, status: 'succeeded', providerId: null, error: null, traceId: null, result: null, createdAt: now, updatedAt: now, pollAfter: 0 });
            store.addTrack({ id, jobId, providerId: id, title: input.title, mode: input.mode, duration: files.duration, sourceDuration: files.sourceDuration,
              origin: 'uploaded', checksum: hash, model: '本地上传', lyrics: '', lyricsSections: null, createdAt: now, saveStatus: 'saved', saveError: null,
              url: '', sourceFile: files.originalFile, localFile: files.previewFile, contentType: 'audio/mpeg', processingVersion: AUDIO_PROCESSING_VERSION });
          })();
        } catch (error) {
          await Promise.allSettled([unlink(path.join(directory, files.originalFile)), unlink(path.join(directory, files.previewFile))]);
          throw error;
        }
        await runner.saveTrack(id);
      })();
      if (!running) imports.set(id, { hash, task, ownerId: request.user!.id, kind: 'music' });
      await task;
      return reply.code(201).send(store.publicTracks().find(track => track.id === id));
    } catch (error) {
      const message = error instanceof Error && /^(请导入|素材需要|素材转换)/.test(error.message) ? error.message : '音频上传未完成，请确认文件可播放后重试。原文件会完整保留。';
      return reply.code(400).send({ message });
    } finally { if (imports.get(id)?.ownerId === request.user!.id) imports.delete(id); }
  });
  app.get('/api/tracks/:id/original', async (request, reply) => {
    const { id } = idSchema.parse(request.params); const track = request.userStore.getTrack(id);
    if (!track || track.deletedAt || track.origin !== 'uploaded' || !track.sourceFile) return reply.code(404).send({ message: '没有找到上传的原文件。' });
    return sendExport(reply, directory, track.title, track.sourceFile, [], false);
  });
  app.post('/api/tracks/:id/lyrics/adopt', async (request, reply) => {
    const store = request.userStore; const { id } = idSchema.parse(request.params);
    const { jobId } = z.object({ jobId: z.string().uuid() }).parse(request.body);
    const track = store.getTrack(id); const job = store.getJob(jobId);
    if (!track || track.deletedAt || !job || job.kind !== 'recognize' || job.tool?.sourceTrackId !== id || job.status !== 'succeeded' || !job.result?.lyrics.trim()) return reply.code(400).send({ message: '请先完成这首作品的歌词识别，再采用结果。' });
    await runner.adoptLyrics(id, job.result);
    return store.publicTracks().find(track => track.id === id);
  });
  app.post('/api/materials', { bodyLimit: MAX_MATERIAL_BYTES }, async (request, reply) => {
    const store = request.userStore;
    const { id, name } = z.object({ id: z.string().uuid(), name: nameSchema }).parse(request.query);
    if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ message: '请选择一个音频文件。' });
    const bytes = request.body; const hash = createHash('sha256').update(bytes).digest('hex');
    const existing = store.getMaterial(id);
    if (!existing && globalStore.getMaterial(id)) return reply.code(409).send({ message: '导入编号已使用，请重新选择文件。' });
    if (existing) {
      if (existing.checksum !== hash) return reply.code(409).send({ message: '导入编号已经使用，请重新选择文件。' });
      return store.publicMaterials().find(asset => asset.id === id);
    }
    const running = imports.get(id);
    if (running && (running.ownerId !== request.user!.id || running.kind !== 'material')) return reply.code(409).send({ message: '导入编号已使用，请重试。' });
    if (running && running.hash !== hash) return reply.code(409).send({ message: '同一次导入的文件发生了变化，请重试。' });
    if (!running && imports.size >= 2) return reply.code(429).send({ message: '请等当前素材处理完成，再导入下一段。' });
    try {
      const task = running?.task || (async () => {
        const result = await importMaterial(bytes, name, directory, id);
        store.addMaterial({ id, name, ...result, checksum: hash, createdAt: Date.now(), deletedAt: null });
      })();
      if (!running) imports.set(id, { hash, task, ownerId: request.user!.id, kind: 'material' });
      await task;
      return reply.code(201).send(store.publicMaterials().find(asset => asset.id === id));
    } catch (error) {
      const message = error instanceof Error && /^(请导入|素材需要|素材转换)/.test(error.message) ? error.message : '这份文件暂时无法读取，请确认它是有效的音频，并检查本机音频工具。';
      return reply.code(400).send({ message });
    } finally { imports.delete(id); }
  });
  app.patch('/api/materials/:id', async (request, reply) => {
    const store = request.userStore;
    const { id } = idSchema.parse(request.params); const asset = store.getMaterial(id);
    const patch = z.object({ name: nameSchema.optional(), deleted: z.boolean().optional() }).parse(request.body);
    if (!asset) return reply.code(404).send({ message: '没有找到这份素材。' });
    if (patch.deleted && store.listJobs().some(j => j.input.source?.assetId === id && !terminalStatuses.includes(j.status))) return reply.code(409).send({ message: '这份素材仍在创作任务中使用，请等任务完成后再移除。' });
    store.updateMaterial(id, { ...(patch.name ? { name: patch.name } : {}), ...(patch.deleted === undefined ? {} : { deletedAt: patch.deleted ? Date.now() : null }) });
    return { ok: true };
  });
  app.get('/api/materials/:id/media', async (request, reply) => {
    const store = request.userStore;
    const { id } = idSchema.parse(request.params); const asset = store.getMaterial(id);
    if (!asset || asset.deletedAt) return reply.code(404).send({ message: '这份素材已移除，可恢复后试听。' });
    const { download } = z.object({ download: z.string().optional() }).parse(request.query);
    if (download) reply.header('Content-Disposition', attachment(`${safeName(path.parse(asset.name).name)}.mp3`));
    return reply.type('audio/mpeg').header('Cache-Control', 'private, no-cache').sendFile(asset.previewFile, directory, { cacheControl: false });
  });
  app.post('/api/collections', async (request, reply) => {
    const store = request.userStore;
    const input = z.object({ id: z.string().uuid(), name: nameSchema }).parse(request.body); const existing = store.getCollection(input.id);
    if (existing) return existing.name === input.name ? existing : reply.code(409).send({ message: '这个作品集编号已使用，请重试。' });
    store.addCollection({ ...input, createdAt: Date.now(), archivedAt: null });
    return reply.code(201).send(store.getCollection(input.id));
  });
  app.patch('/api/collections/:id', async (request, reply) => {
    const store = request.userStore;
    const { id } = idSchema.parse(request.params); const input = z.object({ name: nameSchema.optional(), archived: z.boolean().optional() }).parse(request.body);
    if (!store.getCollection(id)) return reply.code(404).send({ message: '没有找到这个作品集。' });
    store.updateCollection(id, { ...(input.name ? { name: input.name } : {}), ...(input.archived === undefined ? {} : { archivedAt: input.archived ? Date.now() : null }) });
    return { ok: true };
  });
  app.post('/api/tracks/:id/exports', async (request, reply) => {
    const store = request.userStore;
    const { id } = idSchema.parse(request.params); const { format } = z.object({ format: z.enum(['flac', 'wav']) }).parse(request.body);
    const track = store.getTrack(id);
    if (!track || track.deletedAt || track.saveStatus !== 'saved') return reply.code(409).send({ message: '请先完成原作品的保存。' });
    if (!(format === 'flac' ? track.flacUrl : track.wavUrl) && path.extname(track.localFile || '') !== `.${format}` && !(track.origin === 'uploaded' && path.extname(track.sourceFile || '') === `.${format}`)) return reply.code(400).send({ message: '这首作品没有提供此格式。' });
    let output = store.listExports().find(e => e.trackId === id && e.format === format);
    if (!output) { const exportId = randomUUID(); store.addExport({ id: exportId, trackId: id, format, status: 'saving' }); output = store.getExport(exportId)!; }
    void runner.saveFormat(output.id); return reply.code(202).send(store.publicExports().find(e => e.id === output.id));
  });
  app.get('/api/exports/:id/download', async (request, reply) => {
    const store = request.userStore;
    const { id } = idSchema.parse(request.params); const output = store.getExport(id); const track = output && store.getTrack(output.trackId);
    if (!output?.localFile || output.status !== 'saved' || !track || track.deletedAt) return reply.code(404).send({ message: '这个格式还未保存完成。' });
    const { bundle } = z.object({ bundle: z.literal('1').optional() }).parse(request.query);
    return sendExport(reply, directory, track.title, output.localFile, [output.lyricsFile, output.timedLyricsFile], bundle === '1');
  });
}
