import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync, zipSync } from 'fflate';
import { buildApp } from '../apps/server/src/app.js';
import { MurekaProvider, ProviderError } from '../apps/server/src/provider.js';
import { toolInputSchema, toMurekaToolBody, toolRangeError, type ToolInput } from '../packages/shared/src/index.js';
import { stemEntries, stemLabel, regionResultError } from '../apps/server/src/creative-audio.js';
import { audioDuration } from '../apps/server/src/postprocess.js';
import { testCredentials, loginAs, FakeProvider, fakeDownload, fakeArchiveDownload, sampleJob, testWav } from './helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(archiveDownloader = fakeArchiveDownload, downloader = fakeDownload) {
  const root = await mkdtemp(path.join(tmpdir(), 'chenglan-tools-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const provider = new FakeProvider();
  const server = await buildApp({ root, provider, bootstrap: testCredentials, downloader, archiveDownloader }); cleanups.push(() => server.app.close());
  const headers = await loginAs(server.app, testCredentials, '127.0.0.1:4173');
  const original = sampleJob({ status: 'succeeded' }); server.store.createJob(original);
  const id = randomUUID(); await writeFile(path.join(root, 'storage', `${id}.wav`), testWav());
  server.store.addTrack({ id, jobId: original.id, providerId: 'old-song-id', title: '最初的歌', mode: 'easy', duration: 8000, sourceDuration: 13000, processingVersion: 1, model: 'fixture', lyrics: '海风吹过窗台', lyricsSections: [{ lines: [{ text: '海风吹过窗台', start: 1000, end: 6000 }] }], createdAt: Date.now() - 60 * 86400000, saveStatus: 'saved', url: 'https://example.com/source.wav', localFile: `${id}.wav`, contentType: 'audio/wav' });
  const post = (tool: ToolInput, submissionId = randomUUID()) => server.app.inject({ method: 'POST', url: '/api/tools', headers, payload: { tool, submissionId } });
  return { ...server, root, provider, headers, id, post };
}

describe('creative tool contracts', () => {
  it('maps only supported fields and enforces millisecond selection bounds', () => {
    const base = { sourceTrackId: randomUUID(), title: '' };
    const extend = toolInputSchema.parse({ ...base, operation: 'extend', at: 4000, direction: 'head', lyrics: '新的开头' });
    expect(toMurekaToolBody(extend, 'upload-1')).toEqual({ upload_audio_id: 'upload-1', lyrics: '新的开头', extend_at: 4000, extend_type: 'head', model: 'mureka-8' });
    const edit = toolInputSchema.parse({ ...base, operation: 'region_edit', start: 1000, end: 4000, lyrics: '替换片段' });
    if (edit.operation !== 'region_edit') throw new Error('Expected a region edit');
    expect(toMurekaToolBody(edit, 'upload-2')).toEqual({ upload_audio_id: 'upload-2', lyrics: '替换片段', edit_start: 1000, edit_end: 4000 });
    expect(toolRangeError(edit, 8000)).toBeNull(); expect(toolRangeError(edit, 3000)).toBeTruthy();
    expect(toolRangeError({ ...edit, operation: 'region_edit', start: 1000, end: 3999, lyrics: '歌词' }, 8000)).toBeTruthy();
    expect(toolInputSchema.safeParse({ ...base, operation: 'extend', at: 4000, direction: 'tail', lyrics: '歌'.repeat(3001) }).success).toBe(false);
    expect(toolRangeError({ ...edit, start: 0, end: 259950 }, 259950)).toContain('整首重制');
    expect(toolRangeError({ ...edit, start: 1000, end: 259000 }, 259950)).toContain('保留');
    const remix = toolInputSchema.parse({ ...base, operation: 'remix', lyrics: '歌'.repeat(5000), prompt: '古风男声' });
    if (remix.operation !== 'remix') throw new Error('Expected a remix');
    expect(toMurekaToolBody(remix, 'remix-upload')).toEqual({ upload_audio_id: 'remix-upload', model: 'mureka-9.5', lyrics: '歌'.repeat(5000), prompt: '古风男声', n: 1 });
    expect(toolRangeError(remix, 10000)).toBeNull(); expect(toolRangeError(remix, 480000)).toBeNull();
    expect(toolRangeError(remix, 9999)).toBeTruthy(); expect(toolRangeError(remix, 480001)).toBeTruthy();
    expect(toMurekaToolBody({ ...remix, lyrics: '' }, 'remix-upload')).toEqual({ upload_audio_id: 'remix-upload', model: 'mureka-9.5', prompt: '古风男声', n: 1 });
    expect(toolInputSchema.safeParse({ ...remix, lyrics: '歌'.repeat(5001) }).success).toBe(false);
    expect(toolInputSchema.safeParse({ ...remix, prompt: '' }).success).toBe(false);
    expect(toolInputSchema.safeParse({ ...remix, prompt: '曲'.repeat(1025) }).success).toBe(false);
    expect(regionResultError({ ...edit, start: 0, end: 259950 }, 259950, 18944)).toContain('18.94');
    expect(regionResultError({ ...edit, start: 30000, end: 50000 }, 259950, 18944)).toBeTruthy();
    expect(regionResultError({ ...edit, start: 30000, end: 50000 }, 259950, 259950)).toBeNull();
    expect(regionResultError(remix, 259950, 18944)).toBeNull();
  });
  it('uploads remix-purpose audio and requests exactly one whole-song remix', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(url.endsWith('/upload') ? { id: 'remix-upload' } : { id: 'remix-task', status: 'running' })); });
    const provider = new MurekaProvider('test-key');
    await provider.uploadAudio(new Uint8Array([1, 2, 3]), 'remix');
    expect((calls[0].init.body as FormData).get('purpose')).toBe('remix');
    await provider.createVersion({ operation: 'remix', sourceTrackId: randomUUID(), title: '', lyrics: '[Verse]\n整首新歌词', prompt: '古风男声' }, 'remix-upload');
    expect(calls[1].url).toBe('https://api.mureka.cn/v1/song/remix');
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ upload_audio_id: 'remix-upload', model: 'mureka-9.5', lyrics: '[Verse]\n整首新歌词', prompt: '古风男声', n: 1 });
  });
  it('uses multipart audio uploads, exact endpoint bodies and private authorization', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init }); return new Response(JSON.stringify(url.endsWith('/upload') ? { id: 'uploaded' } : url.endsWith('/stem') ? { zip_url: 'https://example.com/stems.zip' } : url.endsWith('/lyrics/extend') ? { lyrics: '下一句' } : { id: 123, status: 'running' }), { status: 200 });
    });
    const provider = new MurekaProvider('test-key'); const data = new Uint8Array([1, 2, 3]);
    expect(await provider.uploadAudio(data)).toBe('uploaded');
    expect(calls[0].init.body).toBeInstanceOf(FormData); expect((calls[0].init.body as FormData).get('purpose')).toBe('audio');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    await provider.createVersion({ operation: 'region_edit', sourceTrackId: randomUUID(), title: '', start: 0, end: 4000, lyrics: '歌词' }, 'uploaded');
    expect(calls[1].url).toBe('https://api.mureka.cn/v1/song/region-edit');
    expect(JSON.parse(calls[1].init.body as string)).toHaveProperty('edit_end', 4000);
    expect(await provider.extendLyrics('已经写好')).toHaveProperty('lyrics', '下一句');
    expect(JSON.parse(calls[2].init.body as string)).toEqual({ lyrics: '已经写好' });
    await provider.separate(data, 'vocals'); expect(JSON.parse(calls[3].init.body as string)).toEqual({ url: 'data:audio/mp3;base64,AQID', model: 'audio-separation-3' });
  });
  it('treats invalid successful generation responses as uncertain, without reflecting raw errors', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}'));
    await expect(new MurekaProvider('test').separate(new Uint8Array([1]), 'vocals')).rejects.toMatchObject({ ambiguous: true });
  });
  it('rejects unsafe archives and distinguishes vocals from no-vocals', () => {
    expect(() => stemEntries(zipSync({ '../escaped.wav': testWav() }))).toThrow();
    expect(() => stemEntries(zipSync({ 'readme.txt': new Uint8Array([1]) }))).toThrow();
    expect(stemLabel('song_no_vocals.wav')).toEqual({ label: '伴奏', vocal: false });
    expect(stemLabel('song_vocals.wav')).toEqual({ label: '人声', vocal: true });
  });
});

describe('creative tools through the persistent queue', () => {
  it('validates ranges before enqueue and deduplicates the same tool request', async () => {
    const { id, post, store } = await setup();
    const tool: ToolInput = { sourceTrackId: id, title: '', operation: 'region_edit', start: 1000, end: 3999, lyrics: '新的歌词' };
    expect((await post(tool)).statusCode).toBe(400);
    const valid = { ...tool, end: 6000 }; const submissionId = randomUUID();
    expect((await post(valid, submissionId)).statusCode).toBe(202);
    expect((await post(valid, submissionId)).statusCode).toBe(202);
    expect(store.listJobs().filter(j => j.tool)).toHaveLength(1);
    expect((await post({ ...valid, lyrics: '改变输入' }, submissionId)).statusCode).toBe(409);
    store.updateTrack(id, { deletedAt: Date.now() }); expect((await post(valid)).statusCode).toBe(404);
  });
  it('rejects a whole-song region edit before charging, including legacy queued requests', async () => {
    const { id, post, runner, store, provider } = await setup();
    const tool: ToolInput = { sourceTrackId: id, title: '', operation: 'region_edit', start: 0, end: 8000, lyrics: '整首歌词' };
    const response = await post(tool); expect(response.statusCode).toBe(400); expect(response.json().message).toContain('整首重制');
    const legacy = sampleJob({ kind: 'region_edit', tool }); store.createJob(legacy);
    await runner.tick(); await runner.tick();
    expect(store.getJob(legacy.id)).toMatchObject({ status: 'failed', providerId: null });
    expect(provider.uploadCalls).toBe(0); expect(provider.toolCalls).toBe(0);
  });
  it('flags an actually truncated result even when the cloud declares a full duration, preserving files and IDs', async () => {
    const { root, id, post, runner, store, provider } = await setup(fakeArchiveDownload, async (url, directory, trackId) => {
      const result = await fakeDownload(url, directory, trackId);
      await writeFile(path.join(directory, result.filename), testWav(24)); return result;
    });
    await writeFile(path.join(root, 'storage', `${id}.wav`), testWav(259.95));
    store.updateTrack(id, { duration: 259950 });
    provider.query = async taskId => ({ id: taskId, status: 'succeeded', watermarked: true, choices: [{ id: 'truncated', url: 'https://example.com/song.wav', duration: 264950 }] });
    const jobId = (await post({ sourceTrackId: id, title: '异常短结果', operation: 'region_edit', start: 30000, end: 50000, lyrics: '新副歌' })).json().id;
    await runner.tick(); store.updateJob(jobId, { pollAfter: 0 }); await runner.tick();
    const version = store.listTracks().find(t => t.jobId === jobId)!; await runner.saveTrack(version.id);
    expect(store.getJob(jobId)).toMatchObject({ status: 'failed', providerId: 'tool-1' });
    expect(store.getJob(jobId)?.error).toContain('19.00');
    expect(store.getTrack(version.id)).toMatchObject({ saveStatus: 'saved', sourceDuration: 24000, duration: 19000 });
    expect(await readFile(path.join(root, 'storage', store.getTrack(version.id)!.sourceFile!))).toEqual(testWav(24));
    await runner.saveTrack(version.id); await runner.tick(); expect(provider.toolCalls).toBe(1);
    expect(store.getTrack(id)?.duration).toBe(259950);
  });
  it('audits already saved legacy short edits at startup without regenerating or rewriting audio', async () => {
    const { root, id, runner, store, provider } = await setup(); store.updateTrack(id, { duration: 259950 });
    const job = sampleJob({ kind: 'region_edit', status: 'succeeded', providerId: 'existing-cloud', tool: { operation: 'region_edit', sourceTrackId: id, title: '', lyrics: '整首歌词', start: 0, end: 259950 } }); store.createJob(job);
    const trackId = randomUUID(); const bytes = testWav(19); await writeFile(path.join(root, 'storage', `${trackId}.wav`), bytes);
    store.addTrack({ id: trackId, jobId: job.id, providerId: 'existing-choice', title: '异常旧版本', mode: 'easy', duration: 18944, sourceDuration: 23944, model: 'auto', lyrics: '', createdAt: Date.now(), saveStatus: 'saved', processingVersion: 1, url: 'https://example.com/song.wav', localFile: `${trackId}.wav`, operation: 'region_edit', parentTrackId: id });
    runner.start(); expect(store.getJob(job.id)).toMatchObject({ status: 'failed', providerId: 'existing-cloud' }); await runner.stop();
    expect(await readFile(path.join(root, 'storage', `${trackId}.wav`))).toEqual(bytes); expect(provider.toolCalls).toBe(0); expect(provider.queries).toBe(0);
  });
  it('queues a remix with the right upload purpose, preserves lyrics and origin, and never charges twice', async () => {
    const { root, id, post, runner, store, provider } = await setup();
    await writeFile(path.join(root, 'storage', `${id}.wav`), testWav(13)); store.updateTrack(id, { duration: 13000 });
    const upload = vi.spyOn(provider, 'uploadAudio');
    provider.query = async taskId => ({ id: taskId, status: 'succeeded', choices: [{ id: 'remix-choice', url: 'https://example.com/song.wav', duration: 8000 }] });
    const tool: ToolInput = { operation: 'remix', sourceTrackId: id, title: '整首重制版', lyrics: '[Verse]\n完整新歌词', prompt: '古风男声' }; const submissionId = randomUUID();
    const jobId = (await post(tool, submissionId)).json().id; await post(tool, submissionId); await runner.tick();
    expect(upload).toHaveBeenCalledWith(expect.any(Uint8Array), 'remix');
    store.updateJob(jobId, { pollAfter: 0 }); await runner.tick();
    const version = store.listTracks().find(t => t.jobId === jobId)!; await runner.saveTrack(version.id);
    expect(store.getTrack(version.id)).toMatchObject({ parentTrackId: id, operation: 'remix', title: '整首重制版', saveStatus: 'saved' });
    expect(store.getTrack(version.id)?.lyrics).toContain('完整新歌词'); expect(store.getJob(jobId)?.status).toBe('succeeded');
    await runner.tick(); expect(provider.toolCalls).toBe(1); expect(provider.submissions).toBe(0);
    store.updateTrack(id, { mode: 'instrumental' }); expect((await post({ ...tool, lyrics: '' })).statusCode).toBe(202);
  });
  it('uploads an old local song, creates a related version and keeps source audio and drafts intact', async () => {
    const { root, id, post, runner, store, provider, app, headers } = await setup();
    const sourceBytes = await readFile(path.join(root, 'storage', `${id}.wav`));
    const response = await post({ sourceTrackId: id, title: '更好的副歌', operation: 'region_edit', start: 1000, end: 6000, lyrics: '改写的副歌' });
    const jobId = response.json().id; await runner.tick(); expect(provider.uploadCalls).toBe(1); expect(provider.toolCalls).toBe(1); expect(provider.submissions).toBe(0);
    store.updateJob(jobId, { pollAfter: 0 }); await runner.tick();
    const version = store.listTracks().find(t => t.parentTrackId === id)!; await runner.saveTrack(version.id);
    expect(store.getTrack(version.id)).toMatchObject({ operation: 'region_edit', duration: 3000, lyrics: '这是一段本地测试旋律', title: '更好的副歌', saveStatus: 'saved' });
    expect(store.listDrafts()).toHaveLength(0); expect(await readFile(path.join(root, 'storage', `${id}.wav`))).toEqual(sourceBytes);
    const download = await app.inject({ url: `/media/${version.id}?download=1&bundle=1`, headers });
    expect(Object.keys(unzipSync(download.rawPayload))).toContain('更好的副歌.txt');
  });
  it('preserves uncertainty for a charged submission and never automatically repeats it', async () => {
    const { id, post, runner, store, provider } = await setup();
    provider.submitError = new ProviderError('结果待核实', 0, null, true);
    const result = await post({ operation: 'extend', sourceTrackId: id, title: '', lyrics: '延续', direction: 'tail', at: 4000 });
    await runner.tick(); await runner.tick();
    expect(store.getJob(result.json().id)?.status).toBe('submission_unknown'); expect(provider.toolCalls).toBe(1);
  });
  it('downloads a clearly labeled lyric reference when the provider omits the full transcript', async () => {
    const { id, post, runner, store, provider, app, headers } = await setup();
    provider.query = async taskId => ({ id: taskId, status: 'succeeded', choices: [{ id: 'no-transcript', url: 'https://example.com/song.wav', duration: 8000 }] });
    const result = await post({ operation: 'extend', sourceTrackId: id, title: '没有时间歌词', lyrics: '这是新的一句', direction: 'tail', at: 4000 });
    await runner.tick(); store.updateJob(result.json().id, { pollAfter: 0 }); await runner.tick();
    const track = store.listTracks().find(t => t.parentTrackId === id)!; await runner.saveTrack(track.id);
    const download = await app.inject({ url: `/media/${track.id}?download=1&bundle=1`, headers }); const entries = unzipSync(download.rawPayload);
    expect(Buffer.from(entries['没有时间歌词.txt']).toString()).toContain('歌词参考（以实际演唱为准）');
    expect(Buffer.from(entries['没有时间歌词.txt']).toString()).toContain('这是新的一句');
    expect(entries['没有时间歌词.lrc']).toBeUndefined();
  });
  it('does not classify a failed source upload as a potentially charged generation', async () => {
    const { id, post, runner, store, provider } = await setup();
    provider.uploadAudio = async () => { throw new ProviderError('上传断开', 0, null, true); };
    const result = await post({ operation: 'extend', sourceTrackId: id, title: '', lyrics: '延续', direction: 'tail', at: 4000 });
    await runner.tick(); expect(store.getJob(result.json().id)?.status).toBe('failed'); expect(provider.toolCalls).toBe(0);
  });
  it('saves a lyric suggestion separately without replacing the song or draft', async () => {
    const { id, post, runner, store, provider } = await setup();
    const result = await post({ operation: 'lyrics_extend', sourceTrackId: id, title: '', lyrics: '海风吹过窗台' }); await runner.tick();
    expect(store.getJob(result.json().id)?.result?.lyrics).toBe('让明天的风带我们去远方');
    expect(store.getTrack(id)?.lyrics).toBe('海风吹过窗台'); expect(store.listDrafts()).toHaveLength(0); expect(provider.extendCalls).toBe(1);
  });
  it('retries only stem saving, preserves duration, saves vocal lyrics and includes them in the bundle and backup', async () => {
    let fail = true;
    const test = await setup(async (...args) => { if (fail) throw new Error('temporary download failure'); return fakeArchiveDownload(...args); });
    const jobId = (await test.post({ operation: 'stem', sourceTrackId: test.id, title: '', preset: 'vocals' })).json().id;
    await test.runner.tick(); await test.runner.saveStems(jobId); expect(test.store.getJob(jobId)?.status).toBe('save_failed');
    fail = false; await test.runner.saveStems(jobId); expect(test.store.getJob(jobId)?.status).toBe('succeeded'); expect(test.provider.stemCalls).toBe(1);
    const stems = test.store.listTracks().filter(t => t.jobId === jobId); expect(stems).toHaveLength(2);
    for (const stem of stems) { expect(stem.duration).toBe(8000); expect(stem.processingVersion).toBe(1); expect(await audioDuration(path.join(test.root, 'storage', stem.localFile!))).toBe(8000); }
    expect(stems.find(t => t.stemName === '人声')?.lyricsFile).toBeTruthy(); expect(stems.find(t => t.stemName === '伴奏')?.lyrics).toBe('');
    const snapshot = await test.app.inject({ url: '/api/snapshot', headers: test.headers }); expect(snapshot.body).not.toContain('stems.zip');
    const bundle = await test.app.inject({ url: `/api/jobs/${jobId}/download`, headers: test.headers }); const names = Object.keys(unzipSync(bundle.rawPayload));
    expect(names.filter(n => n.endsWith('.wav'))).toHaveLength(2); expect(names.some(n => n.endsWith('.txt'))).toBe(true); expect(names.some(n => n.endsWith('.lrc'))).toBe(true);
    const backup = await test.app.inject({ method: 'POST', url: '/api/backup', headers: test.headers }); const entries = unzipSync(backup.rawPayload);
    expect(JSON.parse(Buffer.from(entries['manifest.json']).toString()).version).toBe(8);
    expect(entries[`storage/${stems[0].localFile}`]).toBeTruthy();
    await test.runner.saveStems(jobId); expect(test.store.listTracks().filter(t => t.jobId === jobId)).toHaveLength(2); expect(test.provider.stemCalls).toBe(1);
  });
  it('recovers source preparation safely while holding an interrupted paid submission', async () => {
    const { store } = await setup(); const preparing = sampleJob({ status: 'preparing_source' }); const submitting = sampleJob({ status: 'submitting' });
    store.createJob(preparing); store.createJob(submitting); store.recover();
    expect(store.getJob(preparing.id)?.status).toBe('local_queued'); expect(store.getJob(submitting.id)?.status).toBe('submission_unknown');
  });
});
