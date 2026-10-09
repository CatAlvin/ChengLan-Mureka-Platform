import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync, zipSync } from 'fflate';
import { buildApp } from '../apps/server/src/app.js';
import { MurekaProvider, ProviderError } from '../apps/server/src/provider.js';
import { toolInputSchema, toMurekaToolBody, toolRangeError, type ToolInput } from '../packages/shared/src/index.js';
import { scoreEntries, saveScoreEntries, scoreFilename } from '../apps/server/src/score-files.js';
import { jobProgress } from '../apps/web/src/lib/job-progress.js';
import { FakeProvider, fakeDownload, fakeArchiveDownload, loginAs, sampleJob, testCredentials, testWav } from './helpers.js';
import type { Downloader } from '../apps/server/src/media.js';

export const scoreZip = () => zipSync({ 'nested/旋律.musicxml': Buffer.from('<?xml version="1.0"?><score-partwise version="4.0"><part-list/></score-partwise>'), 'nested/旋律.pdf': Buffer.from('%PDF-1.4\n%%EOF'), 'lyrics.json': Buffer.from('{"lyrics_sections":[]}') });
export const midiZip = () => zipSync({ 'vocals.mid': new Uint8Array([77,84,104,100,0,0,0,6,0,0,0,1,0,96,77,84,114,107,0,0,0,4,0,255,47,0]) });
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const action of cleanup.splice(0).reverse()) await action(); });
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'chenglan-composition-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = new FakeProvider(); let failSave = false; let failOnlyMidi = false;
  const archiveDownloader: Downloader = async (url, directory, id) => {
    if (failSave && (!failOnlyMidi || url.includes('midi'))) throw new Error('temporary save failure');
    if (url.endsWith('/stems.zip')) return fakeArchiveDownload(url, directory, id);
    const bytes = url.includes('midi') ? midiZip() : scoreZip(); const filename = `${id}.zip`;
    await writeFile(path.join(directory, filename), bytes); return { filename, bytes: bytes.length, contentType: 'application/zip' };
  };
  const server = await buildApp({ root, provider, bootstrap: testCredentials, downloader: fakeDownload, archiveDownloader }); cleanup.push(() => server.app.close());
  const headers = await loginAs(server.app); const job = sampleJob({ status: 'succeeded' }); server.store.createJob(job);
  const id = randomUUID(); await writeFile(path.join(root, 'storage', `${id}.wav`), testWav(20));
  server.store.addTrack({ id, jobId: job.id, providerId: 'source', title: '参考音乐', mode: 'lyrics', duration: 20000, sourceDuration: 25000, processingVersion: 1, model: 'test', lyrics: '原曲歌词', lyricsSections: null, createdAt: Date.now(), saveStatus: 'saved', url: 'https://example.com/source.wav', localFile: `${id}.wav`, contentType: 'audio/wav' });
  const post = (tool: ToolInput, submissionId = randomUUID()) => server.app.inject({ method: 'POST', url: '/api/tools', headers, payload: { submissionId, tool } });
  return { ...server, root, provider, id, headers, post, setSaveFailure: (value: boolean, midiOnly = false) => { failSave = value; failOnlyMidi = midiOnly; } };
}
const single = (id: string): ToolInput => ({ operation: 'track', sourceTrackId: id, title: '吉他新轨', start: 0, end: 10000, prompt: '柔和木吉他', generateType: 'Guitar', lyrics: '', vocalGender: 'auto' });

describe('v0.6 official contracts', () => {
  it('requires lyrics only for vocals and strips irrelevant vocal fields from instruments', () => {
    const track = single(randomUUID());
    expect(toMurekaToolBody(track, 'uploaded')).toEqual({ upload_audio_id: 'uploaded', generate_type: 'Guitar', generate_start: 0, generate_end: 10000, prompt: '柔和木吉他' });
    expect(toolInputSchema.safeParse({ ...track, generateType: 'Vocals' }).success).toBe(false);
    const vocals = toolInputSchema.parse({ ...track, generateType: 'Vocals', lyrics: '唱出新的歌', vocalGender: 'female' });
    expect(toMurekaToolBody(vocals, 'uploaded')).toMatchObject({ lyrics: '唱出新的歌', vocal_gender: 'female' });
    expect(toolRangeError({ ...track, end: 20001 } as ToolInput, 20000)).toBeTruthy();
    expect(toolRangeError({ operation: 'transcribe', sourceTrackId: randomUUID(), title: '' }, 9999)).toBeTruthy();
  });
  it('uses track generation, synchronous transcription, and separation-2 MIDI responses', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(init.body as string) }); return new Response(JSON.stringify(url.endsWith('/generate') ? { id: 'track-task', status: 'queued' } : url.endsWith('/transcribe') ? { zip_url: 'https://example.com/score.zip' } : { zip_url: 'https://example.com/stems.zip', midi_zip_url: 'https://example.com/midi.zip' })); });
    const provider = new MurekaProvider('test-only');
    await provider.createVersion(single(randomUUID()), 'source');
    expect(calls[0].url).toBe('https://api.mureka.cn/v1/track/generate');
    expect(await provider.transcribe('source', '乐谱')).toBe('https://example.com/score.zip');
    expect(calls[1].body).toEqual({ upload_audio_id: 'source', title: '乐谱' });
    expect(await provider.separate(new Uint8Array([1]), 'detailed')).toEqual({ audio: 'https://example.com/stems.zip', midi: 'https://example.com/midi.zip' });
    expect(calls[2].body).toMatchObject({ model: 'audio-separation-2' });
  });
  it('keeps malformed successful transcription responses uncertain', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}'));
    await expect(new MurekaProvider('test-only').transcribe('source', '')).rejects.toMatchObject({ ambiguous: true });
  });
  it('rejects unsafe paths, invalid files and XML entities before any files are saved', () => {
    expect(() => scoreEntries(zipSync({ '../escape.pdf': Buffer.from('%PDF-') }))).toThrow();
    expect(() => scoreEntries(zipSync({ 'score.pdf': Buffer.from('HTML error page') }))).toThrow();
    expect(() => scoreEntries(zipSync({ 'score.musicxml': Buffer.from('<!ENTITY e SYSTEM "file:///secret"><score-partwise/>') }))).toThrow();
    expect(() => scoreEntries(zipSync({ 'vocal.mid': Buffer.from('bad') }), true)).toThrow();
    expect(() => scoreEntries(zipSync({ 'lyrics.json': Buffer.from('{}') }))).toThrow();
  });
});

describe('v0.6 queue, recovery and private downloads', () => {
  it('saves scores, downloads individual files, backs them up, and hides them from another user', async () => {
    const t = await setup(); const response = await t.post({ operation: 'transcribe', sourceTrackId: t.id, title: '我的乐谱' }); const id = response.json().id;
    expect(response.statusCode).toBe(202); await t.runner.tick(); await t.runner.saveScore(id);
    const job = t.store.getJob(id)!; expect(job.status).toBe('succeeded'); expect(job.result?.scoreFiles).toHaveLength(3);
    expect(jobProgress(job, [])).toBe('succeeded'); expect(t.provider.transcribeCalls).toBe(1);
    const file = job.result!.scoreFiles!.find(f => f.format === 'pdf')!;
    const url = `/api/jobs/${id}/files/${file.id}`;
    const downloaded = await t.app.inject({ url, headers: t.headers }); expect(downloaded.headers['content-type']).toBe('application/pdf'); expect(downloaded.headers['content-disposition']).toContain('attachment'); expect(downloaded.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const create = await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: t.headers, payload: { username: 'seconduser', displayName: '另一个用户', password: 'Test-other-123', role: 'user' } }); expect(create.statusCode).toBeLessThan(300);
    const other = await loginAs(t.app, { username: 'seconduser', password: 'Test-other-123' });
    t.store.sqlite.prepare('UPDATE users SET must_change_password=0 WHERE username=?').run('seconduser');
    expect((await t.app.inject({ url, headers: other })).statusCode).toBe(404);
    const snapshot = (await t.app.inject({ url: '/api/snapshot', headers: other })).json(); expect(snapshot.jobs).toHaveLength(0);
    const backup = await t.app.inject({ method: 'POST', url: '/api/backup', headers: t.headers });
    const entries = unzipSync(backup.rawPayload); expect(entries[`storage/${scoreFilename(file)}`]).toBeDefined();
    const publicJob = (await t.app.inject({ url: '/api/snapshot', headers: t.headers })).json().jobs.find((j: { id: string }) => j.id === id); expect(publicJob.artifactUrl).toBeUndefined(); expect(JSON.stringify(publicJob)).not.toContain('example.com/score');
  });
  it('retries failed score downloads without paying for another transcription', async () => {
    const t = await setup(); t.setSaveFailure(true);
    const id = (await t.post({ operation: 'transcribe', sourceTrackId: t.id, title: '' })).json().id;
    await t.runner.tick(); await t.runner.saveScore(id); expect(t.store.getJob(id)?.status).toBe('save_failed');
    t.setSaveFailure(false); expect((await t.app.inject({ method: 'POST', url: `/api/jobs/${id}/save`, headers: t.headers })).statusCode).toBe(202); await t.runner.saveScore(id);
    expect(t.store.getJob(id)?.status).toBe('succeeded'); expect(t.provider.transcribeCalls).toBe(1); expect(t.provider.uploadCalls).toBe(1);
  });
  it('resumes persisted saving scores after recovery without an API request', async () => {
    const t = await setup(); const job = sampleJob({ kind: 'transcribe', status: 'saving', tool: { operation: 'transcribe', sourceTrackId: t.id, title: '' } }); t.store.createJob(job); t.store.updateJob(job.id, { artifactUrl: 'https://example.com/score.zip' });
    t.store.recover(); await t.runner.tick(); await t.runner.saveScore(job.id); expect(t.store.getJob(job.id)?.status).toBe('succeeded'); expect(t.provider.transcribeCalls).toBe(0);
  });
  it('retains ambiguous transcription and never repeats its paid submission', async () => {
    const t = await setup(); t.provider.submitError = new ProviderError('待核实', 0, null, true);
    const id = (await t.post({ operation: 'transcribe', sourceTrackId: t.id, title: '' })).json().id;
    await t.runner.tick(); await t.runner.tick(); expect(t.store.getJob(id)?.status).toBe('submission_unknown'); expect(t.provider.transcribeCalls).toBe(1);
  });
  it('saves accompanying MIDI while retaining all audio stems and recovers partial MIDI failure', async () => {
    const t = await setup(); t.provider.separate = async () => { t.provider.stemCalls++; return { audio: 'https://example.com/stems.zip', midi: 'https://example.com/midi.zip' }; };
    t.setSaveFailure(true, true);
    const id = (await t.post({ operation: 'stem', sourceTrackId: t.id, title: '', preset: 'detailed' })).json().id;
    await t.runner.tick(); await t.runner.saveStems(id);
    expect(t.store.getJob(id)?.status).toBe('save_failed'); expect(t.store.listTracks().filter(track => track.jobId === id)).toHaveLength(2);
    t.setSaveFailure(false); await t.runner.saveStems(id);
    expect(t.store.getJob(id)?.status).toBe('succeeded'); expect(t.store.listTracks().filter(track => track.jobId === id)).toHaveLength(2);
    const file = t.store.getJob(id)!.result!.scoreFiles![0]; expect(file.format).toBe('mid'); expect(t.store.storageFiles()).toContain(scoreFilename(file));
    const response = await t.app.inject({ url: `/api/jobs/${id}/files/${file.id}`, headers: t.headers }); expect(response.headers['content-type']).toBe('audio/midi');
    expect(t.provider.stemCalls).toBe(1);
  });
  it('generates instrumental tracks without inheriting old lyrics and deduplicates requests', async () => {
    const t = await setup(); const tool = single(t.id); const submission = randomUUID(); const id = (await t.post(tool, submission)).json().id;
    expect((await t.post(tool, submission)).json().id).toBe(id);
    await t.runner.tick(); t.store.updateJob(id, { pollAfter: 0 }); await t.runner.tick();
    const output = t.store.listTracks().find(track => track.jobId === id)!; await t.runner.saveTrack(output.id);
    expect(output).toMatchObject({ operation: 'track', mode: 'instrumental', lyrics: '', parentTrackId: t.id }); expect(output.lyricsSections).toBeNull(); expect(t.provider.toolCalls).toBe(1);
    const usage = (await t.app.inject({ url: '/api/admin/usage', headers: t.headers })).json(); expect(usage.users[0].requestedSongs).toBe(2);
  });
  it('keeps deterministic file identities across repeated local saves', async () => {
    const t = await setup(); const entries = scoreEntries(scoreZip()); const id = randomUUID();
    const first = await saveScoreEntries(entries, path.join(t.root, 'storage'), id); const second = await saveScoreEntries(entries, path.join(t.root, 'storage'), id); expect(second).toEqual(first);
    expect(await readFile(path.join(t.root, 'storage', scoreFilename(first[0])))).toEqual(Buffer.from(entries[0][1]));
  });
});
