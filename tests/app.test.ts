import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import { buildApp } from '../apps/server/src/app.js';
import { Store } from '../apps/server/src/db.js';
import { ProviderError } from '../apps/server/src/provider.js';
import { testCredentials, loginAs, FakeProvider, fakeDownload, sampleInput, sampleJob } from './helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(downloader = fakeDownload, port = 4173) {
  const root = await mkdtemp(path.join(tmpdir(), 'chenglan-test-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const provider = new FakeProvider();
  const server = await buildApp({ root, provider, bootstrap: testCredentials, downloader, port });
  cleanups.push(() => server.app.close());
  const headers = await loginAs(server.app, testCredentials, `127.0.0.1:${port}`);
  const enqueue = async (endpoint = '/api/jobs') => (await server.app.inject({ method: 'POST', url: endpoint, headers, payload: { submissionId: randomUUID(), input: sampleInput() } })).json();
  return { ...server, root, provider, headers, enqueue };
}

describe('local API and persistent queue', () => {
  it('isolates cookies when a test instance and the real instance share one browser host', async () => {
    const first = await setup(); const second = await setup(fakeDownload, 4174);
    const cookie = `${first.headers.cookie}; ${second.headers.cookie}`;
    expect(first.headers.cookie.split('=')[0]).not.toBe(second.headers.cookie.split('=')[0]);
    expect((await first.app.inject({ url: '/api/snapshot', headers: { ...first.headers, cookie } })).statusCode).toBe(200);
    expect((await second.app.inject({ url: '/api/snapshot', headers: { ...second.headers, cookie } })).statusCode).toBe(200);
  });
  it('resumes querying a known provider ID after a transient query failure without generating again', async () => {
    const { runner, store, provider } = await setup();
    const job = sampleJob({ status: 'running', providerId: 'saved-id' }); store.createJob(job);
    provider.queryError = new Error('temporary network failure'); await runner.tick();
    expect(store.getJob(job.id)?.providerId).toBe('saved-id');
    expect(store.getJob(job.id)?.status).toBe('running');
    provider.queryError = null; store.updateJob(job.id, { pollAfter: 0 }); await runner.tick();
    expect(store.getJob(job.id)?.status).toBe('succeeded');
    expect(provider.submissions).toBe(0);
  });
  it('requires the local host, session and mutation token', async () => {
    const { app, headers } = await setup();
    expect((await app.inject({ url: '/api/session', headers: { host: 'evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/snapshot', headers: { host: headers.host } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/account/refresh', headers: { host: headers.host, cookie: headers.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/session', headers: { ...headers, origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/Mureka-API-Key.txt', headers })).statusCode).toBe(404);
  });
  it('deduplicates repeated submissions and rejects changed input with the same identifier', async () => {
    const { app, headers, store, runner, provider } = await setup();
    const payload = { submissionId: randomUUID(), input: sampleInput() };
    const requests = await Promise.all([1, 2, 3].map(() => app.inject({ method: 'POST', url: '/api/jobs', headers, payload })));
    expect(requests.every(r => r.statusCode === 202)).toBe(true);
    expect(new Set(requests.map(r => r.json().id)).size).toBe(1);
    expect(store.listJobs()).toHaveLength(1);
    const conflict = await app.inject({ method: 'POST', url: '/api/jobs', headers, payload: { ...payload, input: { ...payload.input, title: 'changed' } } });
    expect(conflict.statusCode).toBe(409);
    await Promise.all([runner.tick(), runner.tick()]);
    expect(provider.submissions).toBe(1);
  });
  it('obeys concurrency and saves results before starting the next queued item', async () => {
    const { enqueue, runner, store, provider } = await setup();
    const first = await enqueue(); const second = await enqueue();
    await runner.tick(); await runner.tick();
    expect(provider.submissions).toBe(1);
    expect(store.getJob(second.id)?.status).toBe('local_queued');
    store.updateJob(first.id, { pollAfter: 0 }); await runner.tick();
    expect(provider.submissions).toBe(2);
    const [track] = store.listTracks(); await runner.saveTrack(track.id);
    expect(store.getJob(first.id)?.status).toBe('succeeded');
    expect(store.getTrack(track.id)?.saveStatus).toBe('saved');
    expect(store.publicTracks()[0].playbackUrl).toBe(`/media/${track.id}?v=1`);
    expect(store.publicTracks()[0]).not.toHaveProperty('url');
  });
  it('holds an ambiguous submission without spending again, until explicitly reconciled', async () => {
    const { app, headers, enqueue, runner, store, provider } = await setup();
    provider.submitError = new ProviderError('提交待核实', 0, null, true);
    const first = await enqueue(); await runner.tick(); await enqueue(); await runner.tick();
    expect(provider.submissions).toBe(1);
    expect(store.getJob(first.id)?.status).toBe('submission_unknown');
    const noAcknowledgment = await app.inject({ method: 'POST', url: `/api/jobs/${first.id}/reconcile`, headers, payload: {} });
    expect(noAcknowledgment.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${first.id}/reconcile`, headers, payload: { checked: true, providerId: 'recovered-id' } })).statusCode).toBe(400);
    store.updateJob(first.id, { providerId: 'recovered-id', status: 'running' });
    provider.submitError = null; await runner.tick();
    expect(store.getJob(first.id)?.status).toBe('succeeded');
    expect(provider.queries).toBe(1);
  });
  it('marks a known rejection failed and keeps the input available', async () => {
    const { enqueue, runner, store, provider } = await setup();
    provider.submitError = new ProviderError('内容未通过审核', 451);
    const job = await enqueue(); await runner.tick();
    expect(store.getJob(job.id)?.status).toBe('failed');
    expect(store.getJob(job.id)?.input.prompt).toBe(sampleInput().prompt);
  });
  it('keeps work local when the balance is zero and permits cancellation only before submission', async () => {
    const { app, headers, enqueue, runner, store, provider } = await setup();
    provider.balance = 0; const job = await enqueue(); await runner.tick();
    expect(provider.submissions).toBe(0);
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers })).statusCode).toBe(200);
    expect(store.getJob(job.id)?.status).toBe('cancelled');
    const next = await enqueue(); provider.balance = 100; await runner.refreshAccount(true); await runner.tick();
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${next.id}/cancel`, headers })).statusCode).toBe(409);
  });
  it('retries saving the existing audio without invoking generation', async () => {
    let fail = true;
    const test = await setup(async (...args) => { if (fail) throw new Error('disk full'); return fakeDownload(...args); });
    const job = await test.enqueue(); await test.runner.tick(); test.store.updateJob(job.id, { pollAfter: 0 }); await test.runner.tick();
    const [track] = test.store.listTracks(); await test.runner.saveTrack(track.id);
    expect(test.store.getTrack(track.id)?.saveStatus).toBe('save_failed');
    fail = false; await test.runner.saveTrack(track.id);
    expect(test.store.getTrack(track.id)?.saveStatus).toBe('saved');
    expect(test.provider.submissions).toBe(1);
  });
  it('serves range requests, restores trashed audio and backs up database plus media', async () => {
    const { app, headers, enqueue, runner, store, root } = await setup();
    const job = await enqueue(); await runner.tick(); store.updateJob(job.id, { pollAfter: 0 }); await runner.tick();
    const [track] = store.listTracks(); await runner.saveTrack(track.id);
    const range = await app.inject({ url: `/media/${track.id}`, headers: { ...headers, range: 'bytes=0-43' } });
    expect(range.statusCode).toBe(206); expect(range.rawPayload.length).toBe(44); expect(range.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    await app.inject({ method: 'PATCH', url: `/api/tracks/${track.id}`, headers, payload: { deleted: true } });
    expect((await app.inject({ url: `/media/${track.id}`, headers })).statusCode).toBe(404);
    await app.inject({ method: 'PATCH', url: `/api/tracks/${track.id}`, headers, payload: { deleted: false, title: '重命名', favorite: true } });
    expect(store.getTrack(track.id)?.favorite).toBe(true);
    const backup = await app.inject({ method: 'POST', url: '/api/backup', headers });
    expect(backup.statusCode).toBe(200);
    const entries = unzipSync(backup.rawPayload);
    expect(Object.keys(entries).sort()).toEqual(['chenglan.sqlite', 'manifest.json', `storage/${track.id}.wav`, `storage/${track.id}.trimmed-v1.wav`, `storage/${track.id}.trimmed-v1.txt`, `storage/${track.id}.trimmed-v1.lrc`].sort());
    expect(Buffer.from(entries['chenglan.sqlite']).subarray(0, 15).toString()).toBe('SQLite format 3');
    expect(entries[`storage/${track.id}.wav`].length).toBeGreaterThan(44);
    const audio = await app.inject({ url: `/media/${track.id}?download=1`, headers });
    expect(audio.headers['content-type']).toContain('audio/');
    expect(audio.headers['content-disposition']).toContain(encodeURIComponent('重命名.wav'));
    expect(audio.rawPayload).toEqual(await readFile(path.join(root, 'storage', store.getTrack(track.id)!.localFile!)));
    const downloadRange = await app.inject({ url: `/media/${track.id}?download=1`, headers: { ...headers, range: 'bytes=0-43' } });
    expect(downloadRange.statusCode).toBe(206); expect(downloadRange.rawPayload).toEqual(audio.rawPayload.subarray(0, 44));
    const bundle = await app.inject({ url: `/media/${track.id}?download=1&bundle=1`, headers });
    expect(bundle.headers['content-type']).toContain('application/zip');
    const downloaded = unzipSync(bundle.rawPayload);
    expect(Object.keys(downloaded).sort()).toEqual(['重命名.wav', '重命名.txt', '重命名.lrc'].sort());
    expect(Buffer.from(downloaded['重命名.lrc']).toString()).toContain('[00:00.00]');
    expect((await app.inject({ url: `/api/tracks/${track.id}/lyrics`, headers })).body).toContain('这是一段本地测试旋律');
    expect(store.getTrack(track.id)?.duration).toBe(3000);
  });
  it('stores a generated lyric draft without replacing the user draft', async () => {
    const { enqueue, runner, store, provider } = await setup();
    const job = await enqueue('/api/lyrics'); await runner.tick();
    expect(store.getJob(job.id)?.result?.lyrics).toContain('[Verse]');
    expect(store.listDrafts()[0].input.lyrics).toBe('');
    expect(provider.lyricCalls).toBe(1); expect(provider.submissions).toBe(0);
  });
  it('persists drafts and treats an interrupted submission conservatively on reopen', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'chenglan-db-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const store = new Store(root); const job = sampleJob({ status: 'submitting' }); const running = sampleJob({ status: 'running', providerId: 'known-provider-id' });
    store.createJob(job); store.createJob(running); store.saveDraft(sampleInput()); store.close();
    const reopened = new Store(root); reopened.recover();
    try {
      expect(reopened.getJob(job.id)?.status).toBe('submission_unknown');
      expect(reopened.getJob(running.id)?.providerId).toBe('known-provider-id');
      expect(reopened.listDrafts()[0].input.prompt).toBe(sampleInput().prompt);
      expect((await readFile(path.join(root, 'chenglan.sqlite'))).length).toBeGreaterThan(0);
    } finally { reopened.close(); }
  });
});
