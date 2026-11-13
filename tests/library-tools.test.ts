import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';
import { buildApp } from '../apps/server/src/app.js';
import { MurekaProvider, ProviderError } from '../apps/server/src/provider.js';
import { audioDuration, trimAudioEnd } from '../apps/server/src/postprocess.js';
import { emptyDraft, generationSchema, toMurekaBody, type CreativeInput } from '../packages/shared/src/index.js';
import { testCredentials, loginAs, FakeProvider, fakeDownload, sampleJob, testWav } from './helpers.js';
import type { Downloader } from '../apps/server/src/media.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup(downloader: Downloader = fakeDownload) {
  const root = await mkdtemp(path.join(tmpdir(), 'chenglan-materials-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = new FakeProvider(); const server = await buildApp({ root, provider, bootstrap: testCredentials, downloader }); cleanup.push(() => server.app.close());
  const headers = await loginAs(server.app, testCredentials, '127.0.0.1:4173');
  const post = (url: string, payload: Record<string, unknown>) => server.app.inject({ method: 'POST', url, headers, payload });
  const patch = (url: string, payload: Record<string, unknown>) => server.app.inject({ method: 'PATCH', url, headers, payload });
  const upload = (id = randomUUID(), data = testWav(40), name = '灵感.wav') => server.app.inject({ method: 'POST', url: `/api/materials?${new URLSearchParams({ id, name })}`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: data });
  async function song() {
    const job = sampleJob({ status: 'succeeded' }); server.store.createJob(job); const id = randomUUID();
    await writeFile(path.join(root, 'storage', `${id}.wav`), testWav());
    server.store.addTrack({ id, jobId: job.id, providerId: id, title: '测试原曲', mode: 'lyrics', duration: 8000, sourceDuration: 13000, processingVersion: 1, model: 'fixture', lyrics: '保留的歌词\n末尾歌词', lyricsSections: [{ lines: [{ text: '保留的歌词', start: 0 }, { text: '末尾歌词', start: 7000 }] }], createdAt: Date.now(), saveStatus: 'saved', url: '', localFile: `${id}.wav`, contentType: 'audio/wav' });
    return id;
  }
  return { ...server, provider, root, headers, post, patch, upload, song };
}
const withSource = (mode: CreativeInput['mode'] = 'lyrics', kind: 'reference' | 'melody' = 'reference'): CreativeInput => ({ ...emptyDraft(mode), prompt: '温暖的歌', lyrics: '歌唱明天', styles: ['folk'], gender: 'female', source: { assetId: randomUUID(), kind, start: 5000, end: 35000 } });

describe('reference and melody contracts', () => {
  it('uses the upload field for each mode without mutually exclusive prompt fields', () => {
    expect(toMurekaBody(withSource('easy'), 'asset')).toMatchObject({ reference_id: 'asset', prompt: expect.any(String), styles: ['folk'] });
    expect(toMurekaBody(withSource('instrumental'), 'asset')).toEqual({ model: 'mureka-9.5', n: 1, stream: false, instrumental_id: 'asset' });
    expect(toMurekaBody(withSource(), 'asset')).toEqual({ model: 'mureka-9.5', n: 1, stream: false, reference_id: 'asset', lyrics: '歌唱明天', gender: 'female' });
    expect(toMurekaBody(withSource('lyrics', 'melody'), 'asset')).toEqual({ model: 'mureka-8', n: 1, stream: false, melody_id: 'asset', lyrics: '歌唱明天' });
    expect(() => toMurekaBody(withSource())).toThrow();
    const instrumental = { ...withSource('instrumental'), prompt: '' }; expect(generationSchema.safeParse(instrumental).success).toBe(true);
    expect(generationSchema.safeParse(withSource('easy', 'melody')).success).toBe(false);
    for (const length of [4999, 60001]) { const input = withSource('lyrics', 'melody'); input.source!.end = input.source!.start + length; expect(generationSchema.safeParse(input).success).toBe(false); }
    const short = withSource(); short.source!.end--; expect(generationSchema.safeParse(short).success).toBe(false);
  });
  it('sends multipart purpose and the returned upload id through the official endpoint', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(url.endsWith('/upload') ? { id: 'uploaded' } : { id: 'song', status: 'running' })); });
    const provider = new MurekaProvider('test-only');
    await provider.uploadAudio(new Uint8Array([1]), 'melody'); await provider.submit(withSource('lyrics', 'melody'), 'uploaded');
    expect((calls[0].init.body as FormData).get('purpose')).toBe('melody');
    expect(calls[1].url).toBe('https://api.mureka.cn/v1/song/generate');
    expect(JSON.parse(calls[1].init.body as string)).toHaveProperty('melody_id', 'uploaded');
  });
});

describe('local materials and grouped generation', () => {
  it('imports intact originals, deduplicates retries, protects playback, and restores removed assets', async () => {
    const t = await setup(); const id = randomUUID(); const bytes = testWav(40);
    const imported = await t.upload(id, bytes); expect(imported.statusCode).toBe(201); expect(imported.json().duration).toBe(40000);
    expect(t.provider.uploadCalls).toBe(0); const asset = t.store.getMaterial(id)!;
    expect(await readFile(path.join(t.root, 'storage', asset.originalFile))).toEqual(bytes);
    expect(await audioDuration(path.join(t.root, 'storage', asset.previewFile))).toBe(40000);
    expect((await t.upload(id, bytes)).statusCode).toBe(200); expect((await t.upload(id, testWav(35))).statusCode).toBe(409);
    expect(t.store.listMaterials()).toHaveLength(1);
    expect((await t.app.inject({ url: imported.json().playbackUrl, headers: { host: t.headers.host } })).statusCode).toBe(401);
    expect((await t.app.inject({ url: imported.json().playbackUrl, headers: { ...t.headers, range: 'bytes=0-99' } })).statusCode).toBe(206);
    await t.patch(`/api/materials/${id}`, { deleted: true }); expect((await t.app.inject({ url: imported.json().playbackUrl, headers: t.headers })).statusCode).toBe(404);
    await t.patch(`/api/materials/${id}`, { deleted: false }); expect(t.store.getMaterial(id)?.deletedAt).toBeNull();
    const snapshot = await t.app.inject({ url: '/api/snapshot', headers: t.headers }); expect(snapshot.body).not.toContain('.source.wav'); expect(snapshot.body).not.toContain(asset.checksum);
  });
  it('rejects invalid or short audio without storing leftovers', async () => {
    const t = await setup();
    expect((await t.upload(randomUUID(), Buffer.from('invalid'))).statusCode).toBe(400);
    expect((await t.upload(randomUUID(), testWav(4))).statusCode).toBe(400);
    expect((await t.upload(randomUUID(), testWav(), 'not-audio.html')).statusCode).toBe(400);
    expect(await readdir(path.join(t.root, 'storage'))).toEqual([]);
  });
  it('prepares exactly 30 seconds, submits once and groups the new song', async () => {
    const t = await setup(); const assetId = (await t.upload()).json().id; const collectionId = randomUUID();
    await t.post('/api/collections', { id: collectionId, name: '旅行' });
    let uploadDuration = 0; let purpose = ''; let submitted: Record<string, unknown> | undefined;
    t.provider.uploadAudio = async (bytes, ...args: unknown[]) => { t.provider.uploadCalls++; purpose = String(args[0]); const file = path.join(t.root, 'clip.mp3'); await writeFile(file, bytes); uploadDuration = await audioDuration(file); return 'actual-upload'; };
    t.provider.submit = async (input, ...args: unknown[]) => { t.provider.submissions++; submitted = toMurekaBody(input, String(args[0])); return { id: 'source-task', status: 'running' }; };
    const input = { ...withSource('instrumental'), collectionId, source: { assetId, kind: 'reference', start: 5000, end: 35000 } }; const submissionId = randomUUID();
    const result = await t.post('/api/jobs', { submissionId, input }); expect(result.statusCode).toBe(202);
    expect((await t.patch(`/api/materials/${assetId}`, { deleted: true })).statusCode).toBe(409);
    await t.post('/api/jobs', { submissionId, input }); await t.runner.tick();
    expect(uploadDuration).toBe(30000); expect(purpose).toBe('instrumental'); expect(submitted).toHaveProperty('instrumental_id', 'actual-upload'); expect(t.provider.submissions).toBe(1);
    t.store.updateJob(result.json().id, { pollAfter: 0 }); await t.runner.tick(); const track = t.store.listTracks()[0]; await t.runner.saveTrack(track.id);
    expect(track.collectionId).toBe(collectionId); expect(t.store.listMaterials()).toHaveLength(1);
    expect((await t.patch(`/api/materials/${assetId}`, { deleted: true })).statusCode).toBe(200);
  });
  it('validates material bounds before enqueue and fails upload without a charged submission', async () => {
    const t = await setup(); const assetId = (await t.upload()).json().id; const input = withSource(); input.source!.assetId = assetId;
    expect((await t.post('/api/jobs', { submissionId: randomUUID(), input: { ...input, source: { ...input.source, start: 15000, end: 45000 } } })).statusCode).toBe(400);
    t.provider.uploadAudio = async () => { throw new ProviderError('test disconnect', 0, null, true); };
    const result = await t.post('/api/jobs', { submissionId: randomUUID(), input }); await t.runner.tick();
    expect(t.store.getJob(result.json().id)?.status).toBe('failed'); expect(t.provider.submissions).toBe(0);
    await t.patch(`/api/materials/${assetId}`, { deleted: true }); expect((await t.post('/api/jobs', { submissionId: randomUUID(), input })).statusCode).toBe(400);
  });
  it('archives groups independently of music and inherits the current group in later versions', async () => {
    const t = await setup(); const id = await t.song(); const group = { id: randomUUID(), name: '第一张专辑' };
    expect((await t.post('/api/collections', group)).statusCode).toBe(201); expect((await t.post('/api/collections', group)).statusCode).toBe(200);
    expect((await t.patch(`/api/tracks/${id}`, { collectionId: randomUUID() })).statusCode).toBe(400);
    await t.patch(`/api/tracks/${id}`, { collectionId: group.id }); await t.patch(`/api/collections/${group.id}`, { name: '第二张专辑', archived: true });
    expect(t.store.getTrack(id)?.deletedAt).toBeNull(); expect(t.store.getTrack(id)?.collectionId).toBe(group.id);
    expect((await t.post('/api/jobs', { submissionId: randomUUID(), input: { ...emptyDraft('easy'), prompt: '新歌', collectionId: group.id } })).statusCode).toBe(400);
    await t.patch(`/api/collections/${group.id}`, { archived: false });
    const result = await t.post('/api/tools', { submissionId: randomUUID(), tool: { operation: 'extend', sourceTrackId: id, title: '', at: 4000, direction: 'tail', lyrics: '向前走' } });
    await t.runner.tick(); t.store.updateJob(result.json().id, { pollAfter: 0 }); await t.runner.tick();
    expect(t.store.listTracks().find(track => track.parentTrackId === id)?.collectionId).toBe(group.id);
  });
});

describe('lossless exports and backup', () => {
  it('automatically queues native WAV and FLAC after generation and saves them serially with lyrics', async () => {
    const downloads: string[] = []; let active = 0; let peak = 0;
    const t = await setup(async (url, directory, id) => {
      const extension = path.extname(new URL(url).pathname); downloads.push(extension); active++; peak = Math.max(peak, active);
      try {
        const input = path.join(directory, `${id}-input.wav`); await writeFile(input, testWav());
        const filename = `${id}${extension}`;
        await promisify(execFile)(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-c:a', extension === '.flac' ? 'flac' : extension === '.wav' ? 'pcm_s16le' : 'libmp3lame', path.join(directory, filename)], { windowsHide: true });
        await rm(input); return { filename, bytes: (await readFile(path.join(directory, filename))).length, contentType: extension === '.mp3' ? 'audio/mpeg' : `audio/${extension.slice(1)}` };
      } finally { active--; }
    });
    vi.spyOn(t.provider, 'query').mockResolvedValue({ id: 'fake-1', status: 'succeeded', choices: [{ id: 'all-formats', url: 'https://example.com/original.mp3', wav_url: 'https://example.com/original.wav', flac_url: 'https://example.com/original.flac', lyrics_sections: [{ lines: [{ text: '自动保存歌词', start: 0 }] }] }] });
    const submitted = await t.post('/api/jobs', { submissionId: randomUUID(), input: { ...emptyDraft('easy'), prompt: '保存全部原生格式' } });
    expect(submitted.statusCode).toBe(202); await t.runner.tick(); t.store.updateJob(submitted.json().id, { pollAfter: 0 }); await t.runner.tick();
    const track = t.store.listTracks()[0]; await t.runner.saveTrack(track.id);
    expect(t.store.getTrack(track.id)?.saveStatus).toBe('saved');
    expect(t.store.listExports().map(output => output.format).sort()).toEqual(['flac', 'wav']);
    expect(t.store.listExports().every(output => output.status === 'saving')).toBe(true);
    const original = await readFile(path.join(t.root, 'storage', t.store.getTrack(track.id)!.localFile!));
    await Promise.all([t.runner.savePendingFormat(), t.runner.savePendingFormat()]); await t.runner.savePendingFormat();
    for (const output of t.store.listExports()) {
      expect(output.status).toBe('saved'); expect(output.duration).toBe(3000); expect(output.lyricsFile).toBeTruthy(); expect(output.timedLyricsFile).toBeTruthy();
      const download = await t.app.inject({ url: `/api/exports/${output.id}/download`, headers: t.headers }); expect(download.headers['content-type']).toContain('audio/');
    }
    expect(downloads.sort()).toEqual(['.flac', '.mp3', '.wav']); expect(peak).toBe(1);
    await t.runner.saveTrack(track.id); await t.runner.savePendingFormat(); expect(downloads).toHaveLength(3); expect(t.store.listExports()).toHaveLength(2); expect(t.provider.submissions).toBe(1);
    expect(await readFile(path.join(t.root, 'storage', t.store.getTrack(track.id)!.localFile!))).toEqual(original);
  });
  it('keeps MP3 playable after a format fails and resumes the same export on restart without regenerating', async () => {
    let fail = true; let attempts = 0;
    const t = await setup(async (...args) => { attempts++; if (fail) throw new Error('temporary download failure'); return fakeDownload(...args); });
    const id = await t.song();
    await promisify(execFile)(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(t.root, 'storage', `${id}.wav`), '-c:a', 'libmp3lame', path.join(t.root, 'storage', `${id}.mp3`)], { windowsHide: true });
    t.store.updateTrack(id, { localFile: `${id}.mp3`, contentType: 'audio/mpeg', wavUrl: 'https://example.com/original.wav' });
    const original = await readFile(path.join(t.root, 'storage', `${id}.mp3`));
    await t.runner.saveTrack(id); await t.runner.savePendingFormat();
    const output = t.store.listExports()[0]; expect(output.status).toBe('save_failed'); expect(t.store.getTrack(id)?.saveStatus).toBe('saved');
    await t.runner.tick(); await t.runner.saveTrack(id); await t.runner.savePendingFormat(); expect(attempts).toBe(1);
    fail = false; t.runner.start(); await t.runner.stop();
    expect(t.store.getExport(output.id)?.status).toBe('saved'); expect(t.store.listExports()).toHaveLength(1); expect(attempts).toBe(2); expect(t.provider.submissions).toBe(0);
    expect(await readFile(path.join(t.root, 'storage', `${id}.mp3`))).toEqual(original);
    const playback = await t.app.inject({ url: `/media/${id}`, headers: t.headers }); expect(playback.statusCode).toBe(200); expect(playback.rawPayload).toEqual(original);
  });
  it('preserves 24-bit WAV samples when processing a lossless source', async () => {
    const t = await setup(); const source = path.join(t.root, 'storage', 'input.wav'); await writeFile(source, testWav());
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    await promisify(execFile)(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-c:a', 'pcm_s24le', path.join(t.root, 'storage', 'source24.wav')], { windowsHide: true });
    const processed = await trimAudioEnd('source24.wav', path.join(t.root, 'storage'), randomUUID());
    const ffprobe = process.env.FFPROBE_PATH || (process.env.FFMPEG_PATH ? path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');
    const probe = await promisify(execFile)(ffprobe, ['-v', 'error', '-show_entries', 'stream=bits_per_raw_sample', '-of', 'json', path.join(t.root, 'storage', processed.filename)], { windowsHide: true });
    expect(JSON.parse(probe.stdout).streams[0].bits_per_raw_sample).toBe('24'); expect(processed.duration).toBe(3000);
  });
  it('downloads native WAV directly without trimming again and packages lyrics only on request', async () => {
    const t = await setup(); const id = await t.song(); const result = await t.post(`/api/tracks/${id}/exports`, { format: 'wav' });
    expect(result.statusCode).toBe(202); await t.runner.saveFormat(result.json().id);
    const output = t.store.getExport(result.json().id)!; expect(output.status).toBe('saved'); expect(output.duration).toBe(8000); expect(output.localFile).toBe(`${id}.wav`);
    const audio = await t.app.inject({ url: `/api/exports/${output.id}/download`, headers: t.headers });
    expect(audio.headers['content-type']).toContain('audio/');
    expect(audio.headers['content-disposition']).toContain(encodeURIComponent('测试原曲.wav'));
    expect(audio.rawPayload).toEqual(await readFile(path.join(t.root, 'storage', output.localFile!)));
    const downloaded = await t.app.inject({ url: `/api/exports/${output.id}/download?bundle=1`, headers: t.headers }); const entries = unzipSync(downloaded.rawPayload);
    expect(Object.keys(entries).sort()).toEqual(['测试原曲.lrc', '测试原曲.txt', '测试原曲.wav']);
    expect(Buffer.from(entries['测试原曲.lrc']).toString()).toContain('[00:07.00]');
    await t.post(`/api/tracks/${id}/exports`, { format: 'wav' }); expect(t.store.listExports()).toHaveLength(1);
    expect((await t.post(`/api/tracks/${id}/exports`, { format: 'flac' })).statusCode).toBe(400);
    await t.patch(`/api/tracks/${id}`, { deleted: true }); expect((await t.app.inject({ url: `/api/exports/${output.id}/download`, headers: t.headers })).statusCode).toBe(404);
  });
  it('saves actual FLAC once, clips its lyrics timeline, and includes sources and exports in a v4 backup', async () => {
    let downloads = 0;
    const t = await setup(async (_url, directory, id) => {
      downloads++; const wav = path.join(directory, `${id}-input.wav`); const filename = `${id}.flac`;
      await writeFile(wav, testWav());
      await promisify(execFile)(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'flac', path.join(directory, filename)], { windowsHide: true });
      await rm(wav); return { filename, bytes: (await readFile(path.join(directory, filename))).length, contentType: 'audio/flac' };
    });
    const id = await t.song(); const initial = await readFile(path.join(t.root, 'storage', `${id}.wav`));
    const asset = (await t.upload()).json(); t.store.updateTrack(id, { flacUrl: 'https://example.com/original.flac' });
    const outputId = (await t.post(`/api/tracks/${id}/exports`, { format: 'flac' })).json().id; await t.runner.saveFormat(outputId);
    const output = t.store.getExport(outputId)!; expect(output.status).toBe('saved'); expect(output.duration).toBe(3000);
    expect(await audioDuration(path.join(t.root, 'storage', output.sourceFile!))).toBe(8000);
    expect(await readFile(path.join(t.root, 'storage', `${id}.wav`))).toEqual(initial);
    const audio = await t.app.inject({ url: `/api/exports/${outputId}/download`, headers: t.headers });
    expect(audio.headers['content-type']).toContain('audio/'); expect(audio.rawPayload.subarray(0, 4).toString()).toBe('fLaC');
    expect(audio.headers['content-disposition']).toContain(encodeURIComponent('测试原曲.flac'));
    const downloaded = await t.app.inject({ url: `/api/exports/${outputId}/download?bundle=1`, headers: t.headers }); const files = unzipSync(downloaded.rawPayload);
    expect(Buffer.from(files['测试原曲.flac']).subarray(0, 4).toString()).toBe('fLaC'); expect(Buffer.from(files['测试原曲.lrc']).toString()).not.toContain('[00:07.00]');
    t.store.updateExport(outputId, { status: 'save_failed', lyricsFile: null }); await t.runner.saveFormat(outputId); expect(downloads).toBe(1); expect(t.store.getExport(outputId)?.duration).toBe(3000);
    const backup = unzipSync((await t.post('/api/backup', {})).rawPayload); expect(JSON.parse(Buffer.from(backup['manifest.json']).toString()).version).toBe(8);
    expect(backup[`storage/${t.store.getMaterial(asset.id)!.originalFile}`]).toBeTruthy(); expect(backup[`storage/${output.localFile}`]).toBeTruthy(); expect(backup[`storage/${output.sourceFile}`]).toBeTruthy();
    const snapshot = await t.app.inject({ url: '/api/snapshot', headers: t.headers }); expect(snapshot.body).not.toContain('https://example.com/original.flac');
  });
  it('rejects mislabeled lossless bytes while preserving the playable original', async () => {
    const t = await setup(); const id = await t.song(); t.store.updateTrack(id, { flacUrl: 'https://example.com/mislabeled.flac' });
    const outputId = (await t.post(`/api/tracks/${id}/exports`, { format: 'flac' })).json().id; await t.runner.saveFormat(outputId);
    expect(t.store.getExport(outputId)?.status).toBe('save_failed'); expect(t.store.getTrack(id)?.saveStatus).toBe('saved');
    expect(t.store.getExport(outputId)?.sourceFile).toBeNull();
    expect((await t.app.inject({ url: `/api/exports/${outputId}/download`, headers: t.headers })).statusCode).toBe(404);
  });
});
