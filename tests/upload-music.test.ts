import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import { buildApp } from '../apps/server/src/app.js';
import { MurekaProvider, ProviderError } from '../apps/server/src/provider.js';
import { audioDuration } from '../apps/server/src/postprocess.js';
import { jobProgress } from '../apps/web/src/lib/job-progress.js';
import { testCredentials, loginAs, FakeProvider, fakeDownload, testWav } from './helpers.js';
import type { ToolInput } from '../packages/shared/src/index.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'chenglan-upload-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = new FakeProvider();
  const server = await buildApp({ root, bootstrap: testCredentials, provider, downloader: fakeDownload }); cleanup.push(() => server.app.close());
  const headers = await loginAs(server.app);
  const upload = (id = randomUUID(), data = testWav(), name = '自己的音乐.wav', auth = headers) => server.app.inject({ method: 'POST', url: `/api/tracks/import?${new URLSearchParams({ id, name })}`, headers: { ...auth, 'content-type': 'application/octet-stream' }, payload: data });
  const post = (url: string, payload: Record<string, unknown>, auth = headers) => server.app.inject({ method: 'POST', url, headers: auth, payload });
  const tool = (sourceTrackId: string, operation: 'recognize' | 'describe') => post('/api/tools', { submissionId: randomUUID(), tool: { sourceTrackId, operation } });
  return { ...server, root, headers, provider, upload, post, tool };
}

describe('whole local music uploads', () => {
  it('preserves full audio and native original bytes, with idempotent retries and automatic WAV storage', async () => {
    const t = await setup(); const id = randomUUID(); const bytes = testWav();
    const imported = await t.upload(id, bytes); expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({ id, origin: 'uploaded', duration: 8000, saveStatus: 'saved', hasWav: true, originalUrl: `/api/tracks/${id}/original` });
    const track = t.store.getTrack(id)!;
    expect(track.processingVersion).toBe(1); expect(await audioDuration(path.join(t.root, 'storage', track.localFile!))).toBe(8000);
    expect(await readFile(path.join(t.root, 'storage', track.sourceFile!))).toEqual(bytes);
    expect((await t.app.inject({ url: `/api/tracks/${id}/original`, headers: t.headers })).rawPayload).toEqual(bytes);
    const retry = await t.upload(id, bytes); expect(retry.statusCode).toBe(200); expect(t.store.listTracks()).toHaveLength(1); expect(t.store.listJobs()).toHaveLength(1);
    expect((await t.upload(id, testWav(9))).statusCode).toBe(409);
    await t.runner.savePendingFormat(); const output = t.store.listExports()[0];
    expect(output).toMatchObject({ format: 'wav', status: 'saved', duration: 8000, localFile: track.sourceFile });
    expect((await t.app.inject({ url: `/api/exports/${output.id}/download`, headers: t.headers })).rawPayload).toEqual(bytes);
    await t.runner.saveTrack(id); expect(t.store.getTrack(id)?.duration).toBe(8000);
    const usage = (await t.app.inject({ url: '/api/admin/usage', headers: t.headers })).json();
    expect(usage.users[0]).toMatchObject({ jobs: 0, requestedSongs: 0, tracks: 1 });
    expect(t.provider.submissions + t.provider.uploadCalls + t.provider.toolCalls).toBe(0);
  });
  it('rejects invalid, mislabeled and short files without leaving audio or records behind', async () => {
    const t = await setup();
    for (const [name, bytes] of [['x.exe', testWav()], ['x.wav', Buffer.from('invalid')], ['x.flac', testWav()], ['x.wav', testWav(4)]] as const) {
      expect((await t.upload(randomUUID(), bytes, name)).statusCode).toBe(400);
    }
    expect(t.store.listTracks()).toHaveLength(0); expect(t.store.listJobs()).toHaveLength(0);
    expect(await readdir(path.join(t.root, 'storage'))).toEqual([]);
  });
  it('accepts whole WAV files above the reference-material limit while keeping that limit intact', async () => {
    const t = await setup(); const bytes = Buffer.alloc(26 * 1024 * 1024 + 44);
    testWav().copy(bytes, 0, 0, 44); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.writeUInt32LE(bytes.length - 44, 40);
    bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(96000, 24); bytes.writeUInt32LE(384000, 28); bytes.writeUInt16LE(4, 32);
    const response = await t.upload(randomUUID(), bytes); expect(response.statusCode).toBe(201); expect(response.json().duration).toBeGreaterThan(60000);
    const material = await t.app.inject({ method: 'POST', url: `/api/materials?id=${randomUUID()}&name=x.wav`, headers: { ...t.headers, 'content-type': 'application/octet-stream' }, payload: bytes });
    expect(material.statusCode).toBe(413);
  });
  it('requires authentication and blocks cross-account reads, edits and upload collisions', async () => {
    const t = await setup(); const id = randomUUID(); await t.upload(id);
    expect((await t.upload(randomUUID(), testWav(), 'x.wav', { host: '127.0.0.1:4173', cookie: '', 'x-csrf-token': '' })).statusCode).toBe(403);
    const created = await t.post('/api/admin/users', { username: 'second', displayName: '测试用户', password: 'Temporary-test-123' }); expect(created.statusCode).toBe(201);
    const temporary = await loginAs(t.app, { username: 'second', password: 'Temporary-test-123' });
    await t.post('/api/auth/password', { currentPassword: 'Temporary-test-123', password: 'Changed-test-456' }, temporary);
    const other = await loginAs(t.app, { username: 'second', password: 'Changed-test-456' });
    expect((await t.upload(id, testWav(), 'x.wav', other)).statusCode).toBe(409);
    expect((await t.app.inject({ url: `/api/tracks/${id}/original`, headers: other })).statusCode).toBe(404);
    expect((await t.post('/api/tools', { submissionId: randomUUID(), tool: { operation: 'recognize', sourceTrackId: id } }, other)).statusCode).toBe(404);
    expect((await t.app.inject({ url: '/api/snapshot', headers: other })).json().tracks).toEqual([]);
    const backup = unzipSync((await t.post('/api/backup', {}, other)).rawPayload); expect(Object.keys(backup).some(name => name.startsWith('storage/'))).toBe(false);
  });
  it('allows continuation from a full uploaded work while preserving the parent', async () => {
    const t = await setup(); const id = randomUUID(); await t.upload(id);
    const input: ToolInput = { operation: 'extend', sourceTrackId: id, title: '我的续写', at: 6000, direction: 'tail', lyrics: '接着唱下去' };
    const response = await t.post('/api/tools', { submissionId: randomUUID(), tool: input }); expect(response.statusCode).toBe(202);
    await t.runner.tick(); expect(t.provider.uploadCalls).toBe(1); expect(t.provider.toolCalls).toBe(1);
    expect(t.store.getJob(response.json().id)?.providerId).toBe('tool-1'); expect(t.store.getTrack(id)?.duration).toBe(8000);
    const original = t.store.getTrack(id)!;
    const backup = unzipSync((await t.post('/api/backup', {})).rawPayload);
    expect(JSON.parse(Buffer.from(backup['manifest.json']).toString()).version).toBe(8);
    expect(Buffer.from(backup[`storage/${original.sourceFile}`])).toEqual(testWav());
  });
});

describe('recognition and music analysis', () => {
  it('follows official synchronous API contracts and treats malformed success as uncertain', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify(url.endsWith('recognize') ? { duration: 8000, lyrics_sections: [{ lines: [{ start: 0, end: 5000, text: '歌词' }] }] } : { instrument: ['钢琴'], genres: ['流行'], tags: ['温暖'], description: '温暖的音乐' }));
    });
    const provider = new MurekaProvider('fixture');
    expect(await provider.recognize('uploaded')).toHaveProperty('duration', 8000); await provider.describe(new Uint8Array([1, 2, 3]));
    expect(calls).toEqual([{ url: 'https://api.mureka.cn/v1/song/recognize', body: { upload_audio_id: 'uploaded' } }, { url: 'https://api.mureka.cn/v1/song/describe', body: { url: 'data:audio/mp3;base64,AQID' } }]);
    vi.stubGlobal('fetch', async () => new Response('{}'));
    await expect(provider.recognize('uploaded')).rejects.toMatchObject({ ambiguous: true }); await expect(provider.describe(new Uint8Array([1]))).rejects.toMatchObject({ ambiguous: true });
  });
  it('previews recognized lyrics before adoption and saves TXT/LRC for both playback and native downloads', async () => {
    const t = await setup(); const track = (await t.upload()).json(); await t.runner.savePendingFormat();
    const response = await t.tool(track.id, 'recognize'); await t.runner.tick();
    const job = t.store.getJob(response.json().id)!;
    expect(job.status).toBe('succeeded'); expect(jobProgress(job, [])).toBe('succeeded'); expect(t.store.getTrack(track.id)?.lyrics).toBe('');
    expect(t.provider.recognizeCalls).toBe(1); expect(t.provider.uploadCalls).toBe(1);
    expect(job.result?.timedLyrics).toContain('[00:03.00]和你一起走向未来');
    const adopted = await t.post(`/api/tracks/${track.id}/lyrics/adopt`, { jobId: job.id }); expect(adopted.statusCode).toBe(200);
    expect(adopted.json().lyricsUrl).toBeTruthy(); expect(adopted.json().timedLyricsUrl).toBeTruthy();
    const lrc = await t.app.inject({ url: adopted.json().timedLyricsUrl, headers: t.headers }); expect(lrc.body).toContain('[00:03.00]');
    const output = t.store.listExports()[0]; expect(output.timedLyricsFile).toBeTruthy();
    const audio = await t.app.inject({ url: `/api/exports/${output.id}/download`, headers: t.headers }); expect(audio.rawPayload).toEqual(testWav());
    const bundled = unzipSync((await t.app.inject({ url: `/api/exports/${output.id}/download?bundle=1`, headers: t.headers })).rawPayload);
    expect(Object.keys(bundled).sort()).toEqual(['自己的音乐.lrc', '自己的音乐.txt', '自己的音乐.wav']);
    expect(t.store.getTrack(track.id)?.duration).toBe(8000);
  });
  it('stores analysis independently, without generating a song or overwriting its lyrics', async () => {
    const t = await setup(); const track = (await t.upload()).json();
    const response = await t.tool(track.id, 'describe'); await t.runner.tick(); const job = t.store.getJob(response.json().id)!;
    expect(job.result).toMatchObject({ instruments: ['钢琴', '吉他'], genres: ['民谣'], tags: ['温暖'] }); expect(jobProgress(job, [])).toBe('succeeded');
    expect(t.store.listTracks()).toHaveLength(1); expect(t.provider.describeCalls).toBe(1); expect(t.provider.uploadCalls).toBe(0); expect(t.provider.submissions).toBe(0);
    expect((await t.post(`/api/tracks/${track.id}/lyrics/adopt`, { jobId: job.id })).statusCode).toBe(400);
    const usage = (await t.app.inject({ url: '/api/admin/usage', headers: t.headers })).json(); expect(usage.users[0]).toMatchObject({ jobs: 1, requestedSongs: 0 });
  });
  it('never automatically repeats an uncertain paid recognition after a lost response', async () => {
    const t = await setup(); const track = (await t.upload()).json(); t.provider.submitError = new ProviderError('结果待核实', 0, null, true);
    const response = await t.tool(track.id, 'recognize'); await t.runner.tick(); await t.runner.tick();
    expect(t.store.getJob(response.json().id)?.status).toBe('submission_unknown'); expect(t.provider.recognizeCalls).toBe(1);
    expect(t.store.getTrack(track.id)?.saveStatus).toBe('saved');
  });
});
