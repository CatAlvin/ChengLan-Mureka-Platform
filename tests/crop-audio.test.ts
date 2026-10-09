import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import { buildApp } from '../apps/server/src/app.js';
import { cropLyrics } from '../apps/server/src/creative-audio.js';
import { audioDuration, lrcText } from '../apps/server/src/postprocess.js';
import { emptyDraft, type ToolInput } from '../packages/shared/src/index.js';
import { testCredentials, loginAs, FakeProvider, sampleJob, testWav } from './helpers.js';

const run = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const action of cleanup.splice(0).reverse()) await action(); });
async function setup(origin: 'generated' | 'uploaded' = 'generated') {
  const root = await mkdtemp(path.join(tmpdir(), 'chenglan-crop-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = new FakeProvider(); provider.configured = false; provider.balance = 0;
  const server = await buildApp({ root, provider, bootstrap: testCredentials }); cleanup.push(() => server.app.close());
  const headers = await loginAs(server.app);
  const original = sampleJob({ status: 'succeeded' }); server.store.createJob(original);
  const id = randomUUID(); const filename = `${id}.wav`;
  await writeFile(path.join(root, 'storage', filename), testWav());
  if (origin === 'generated') { const raw = testWav(13); raw.fill(0, 44); await writeFile(path.join(root, 'storage', `${id}.source.wav`), raw); }
  server.store.addTrack({ id, jobId: original.id, providerId: 'original', title: '完整原曲', mode: 'easy', duration: 8000,
    processingVersion: 1, model: 'fixture', lyrics: '第一句\n第二句\n第三句',
    lyricsSections: [{ lines: [{ start: 0, end: 1000, text: '第一句' }, { start: 1000, end: 4000, text: '第二句' }, { start: 4000, end: 7000, text: '第三句' }] }],
    createdAt: Date.now(), saveStatus: 'saved', url: '', localFile: filename, contentType: 'audio/wav', origin,
    // Generated originals are deliberately unavailable: only already saved music is eligible.
    sourceFile: origin === 'uploaded' ? filename : `${id}.source.wav`, sourceDuration: origin === 'uploaded' ? 8000 : 13000 });
  const post = (start = 1250, end = 6750, submissionId = randomUUID()) => server.app.inject({ method: 'POST', url: '/api/tools', headers,
    payload: { submissionId, tool: { sourceTrackId: id, operation: 'crop', title: '我喜欢的片段', start, end } } });
  return { ...server, root, provider, headers, id, filename, post };
}
function pcm(wav: Buffer) {
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString('ascii', offset, offset + 4) === 'data') return wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + size % 2;
  }
  throw new Error('Missing PCM data');
}

describe('sample-accurate local audio cropping', () => {
  it.each(['generated', 'uploaded'] as const)('crops %s music without cloud requests, keeps originals and adjusts lyrics', async origin => {
    const test = await setup(origin); const billing = vi.spyOn(test.provider, 'billing');
    const before = await readFile(path.join(test.root, 'storage', test.filename));
    const response = await test.post(); expect(response.statusCode).toBe(202); const id = response.json().id;
    await test.runner.tick(); await test.runner.saveCrop(id);
    expect(test.store.getJob(id)?.status).toBe('succeeded');
    const clip = test.store.getTrack(id)!;
    expect(clip).toMatchObject({ operation: 'crop', parentTrackId: test.id, duration: 5500, processingVersion: 1, saveStatus: 'saved', lyrics: '第二句\n第三句' });
    expect(await audioDuration(path.join(test.root, 'storage', clip.localFile!))).toBe(5500);
    expect(await readFile(path.join(test.root, 'storage', test.filename))).toEqual(before);
    const wav = test.store.listExports().find(output => output.trackId === id && output.format === 'wav')!;
    expect(wav.status).toBe('saved'); expect(wav.duration).toBe(5500);
    expect(pcm(await readFile(path.join(test.root, 'storage', wav.localFile!)))).toEqual(pcm(before).subarray(16000 * 1250 / 1000 * 2, 16000 * 6750 / 1000 * 2));
    const lrc = await readFile(path.join(test.root, 'storage', clip.timedLyricsFile!), 'utf8');
    expect(lrc).toContain('[00:00.00]第二句'); expect(lrc).toContain('[00:02.75]第三句'); expect(lrc).not.toContain('第一句');
    expect(billing).not.toHaveBeenCalled(); expect(test.provider.uploadCalls + test.provider.toolCalls + test.provider.submissions).toBe(0);
    await test.runner.saveCrop(id); await test.runner.saveTrack(id); await test.runner.saveFormat(wav.id);
    expect(test.store.listTracks().filter(track => track.jobId === id)).toHaveLength(1);
    expect(test.store.getTrack(id)?.duration).toBe(5500);
    const audio = await test.app.inject({ url: `/media/${id}?download=1`, headers: test.headers });
    expect(audio.headers['content-type']).toContain('audio/'); expect(audio.headers['content-type']).not.toContain('zip');
    const backup = await test.app.inject({ method: 'POST', url: '/api/backup', headers: test.headers });
    const entries = unzipSync(backup.rawPayload); expect(entries[`storage/${clip.localFile}`]).toBeTruthy(); expect(entries[`storage/${wav.localFile}`]).toBeTruthy();
    expect(test.store.listDrafts()).toHaveLength(0);
  });
  it('keeps 100 ms and fractional selections playable without an extra end trim', async () => {
    const test = await setup();
    for (const [start, end] of [[7900, 8000], [333, 4567]]) {
      const response = await test.post(start, end); const id = response.json().id; await test.runner.saveCrop(id);
      expect(test.store.getTrack(id)?.duration).toBe(end - start);
      expect(await audioDuration(path.join(test.root, 'storage', test.store.getTrack(id)!.localFile!))).toBe(end - start);
    }
  });
  it('rejects reversed, empty, negative and out-of-bounds ranges before enqueue', async () => {
    const test = await setup();
    for (const range of [[3000, 2000], [1000, 1000], [-1, 3000], [0, 8001], [0, 99], [0.5, 1000]]) expect((await test.post(...range as [number, number])).statusCode).toBe(400);
    expect(test.store.listJobs()).toHaveLength(1);
  });
  it('deduplicates retries and resumes an interrupted crop without creating another work', async () => {
    const test = await setup(); const submission = randomUUID();
    const first = await test.post(1250, 6750, submission); const id = first.json().id;
    expect((await test.post(1250, 6750, submission)).json().id).toBe(id);
    expect((await test.post(1250, 6500, submission)).statusCode).toBe(409);
    test.store.updateJob(id, { status: 'preparing_source' }); test.store.recover();
    expect(test.store.getJob(id)?.status).toBe('local_queued');
    const file = path.join(test.root, 'storage', test.filename); await rename(file, file + '.held');
    await test.runner.saveCrop(id); expect(test.store.getJob(id)?.status).toBe('save_failed'); expect(test.store.getTrack(id)).toBeUndefined();
    await rename(file + '.held', file);
    expect((await test.app.inject({ method: 'POST', url: `/api/jobs/${id}/save`, headers: test.headers })).statusCode).toBe(202);
    await test.runner.saveCrop(id); expect(test.store.getJob(id)?.status).toBe('succeeded');
    expect(test.store.listTracks().filter(track => track.jobId === id)).toHaveLength(1);
  });
  it('allows crops despite cloud slots occupied by unresolved paid jobs', async () => {
    const test = await setup(); test.store.createJob(sampleJob({ status: 'submission_unknown' }));
    const id = (await test.post()).json().id; await test.runner.tick(); await test.runner.saveCrop(id);
    expect(test.store.getJob(id)?.status).toBe('succeeded'); expect(test.provider.submissions).toBe(0);
  });
  it('enforces ownership for sources, retry endpoints, media and resulting works', async () => {
    const test = await setup();
    const user = await test.app.inject({ method: 'POST', url: '/api/admin/users', headers: test.headers, payload: { username: 'cropuser', displayName: '裁剪用户', role: 'user', password: 'Other-user-password-123' } });
    expect(user.statusCode).toBe(201);
    let other = await loginAs(test.app, { username: 'cropuser', password: 'Other-user-password-123' });
    const changed = await test.app.inject({ method: 'POST', url: '/api/auth/password', headers: other, payload: { currentPassword: 'Other-user-password-123', password: 'Changed-password-123' } });
    expect(changed.statusCode).toBe(200);
    other = await loginAs(test.app, { username: 'cropuser', password: 'Changed-password-123' });
    const tool: ToolInput = { sourceTrackId: test.id, operation: 'crop', title: '', start: 0, end: 1000 };
    const denied = await test.app.inject({ method: 'POST', url: '/api/tools', headers: other, payload: { submissionId: randomUUID(), tool } });
    expect(denied.statusCode).toBe(404);
    const id = (await test.post()).json().id; await test.runner.saveCrop(id);
    expect((await test.app.inject({ url: `/media/${id}?download=1`, headers: other })).statusCode).toBe(404);
    expect((await test.app.inject({ method: 'POST', url: `/api/jobs/${id}/save`, headers: other })).statusCode).toBe(409);
  });
  it('preserves native 24-bit WAV and FLAC precision and exact selected PCM', async () => {
    const test = await setup('uploaded'); const directory = path.join(test.root, 'storage');
    const native = `${randomUUID()}.wav`; const flac = `${randomUUID()}.flac`;
    await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', path.join(directory, test.filename), '-c:a', 'pcm_s24le', path.join(directory, native)], { windowsHide: true });
    await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', path.join(directory, native), '-c:a', 'flac', path.join(directory, flac)], { windowsHide: true });
    test.store.updateTrack(test.id, { sourceFile: native });
    test.store.addExport({ id: randomUUID(), trackId: test.id, format: 'flac', status: 'saved', localFile: flac, duration: 8000 });
    const id = (await test.post()).json().id; await test.runner.saveCrop(id);
    const outputs = test.store.listExports().filter(output => output.trackId === id);
    expect(outputs).toHaveLength(2);
    const wav = await readFile(path.join(directory, outputs.find(output => output.format === 'wav')!.localFile!));
    expect(pcm(wav)).toEqual(pcm(await readFile(path.join(directory, native))).subarray(16000 * 1.25 * 3, 16000 * 6.75 * 3));
    const decoded = path.join(directory, `${randomUUID()}.wav`);
    await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', path.join(directory, outputs.find(output => output.format === 'flac')!.localFile!), '-c:a', 'pcm_s24le', decoded], { windowsHide: true });
    expect(pcm(await readFile(decoded))).toEqual(pcm(wav));
  });
  it('does not infer synchronization for untimed lyrics or retain unrelated lines', () => {
    const reference = cropLyrics(null, '没有时间的原歌词', 1000, 2000, 8000);
    expect(reference.lyrics).toContain('歌词参考'); expect(lrcText(reference.sections, 1000)).toBe('');
    const sections = [{ lines: [{ text: '前一句', start: 0, end: 1000 }, { text: '选中一句', start: 1000, end: 2000, words: [{ text: '一句', start: 1800 }] }, { text: '后一句', start: 2000 }] }];
    const clip = cropLyrics(sections, '', 1250, 1750, 8000);
    expect(clip.sections).toEqual([{ lines: [{ text: '选中一句', start: 0, end: 500 }] }]);
    expect(cropLyrics(sections, '原曲歌词', 7000, 8000, 8000).lyrics).toBe('后一句');
    expect(cropLyrics([{ lines: [{ text: '已经唱完', start: 0, end: 1000 }] }], '已经唱完', 2000, 3000, 8000).lyrics).toBe('');
  });
  it('stores a blank draft for the current mode without altering submitted jobs or other modes', async () => {
    const test = await setup();
    const lyrics = { ...emptyDraft('lyrics'), lyrics: '另一个模式的歌词' };
    test.store.saveDraft(lyrics);
    const input = { ...emptyDraft('easy'), source: null, collectionId: null };
    expect((await test.app.inject({ method: 'PUT', url: '/api/drafts', headers: test.headers, payload: input })).statusCode).toBe(200);
    expect(test.store.listDrafts().find(draft => draft.mode === 'easy')?.input).toEqual(input);
    expect(test.store.listDrafts().find(draft => draft.mode === 'lyrics')?.input.lyrics).toBe(lyrics.lyrics);
    expect(test.store.listJobs()).toHaveLength(1);
  });
});
